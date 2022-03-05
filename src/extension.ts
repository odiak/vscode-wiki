import * as vscode from 'vscode'
import * as MarkdownIt from 'markdown-it'
import * as path from 'path'
import { TextDecoder } from 'util'
import Token from 'markdown-it/lib/token'

/**
 * It's like Promise but you can put value multiple times
 */
class LazyVariable<T> implements PromiseLike<T> {
  value: T | undefined = undefined
  private isSettled = false
  private promise: Promise<T>
  private resolve?: (value: T) => void

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  set(value: T) {
    this.value = value
    if (this.isSettled) {
      this.promise = Promise.resolve(value)
    } else {
      this.resolve?.(value)
      this.resolve = undefined
      this.isSettled = true
    }
  }

  then<R1 = T, R2 = never>(
    onFullfilled: (value: T) => R1 | PromiseLike<R1>,
    onRejected?: ((reason?: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.promise.then(onFullfilled, onRejected)
  }
}

class Environment {
  readonly treeP = new LazyVariable<Tree>()
  readonly mdP = new LazyVariable<MarkdownIt>()

  constructor(public readonly rootUri: vscode.Uri) {}
}

export function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.getConfiguration('vscode-wiki').get<boolean>('enabled')) return

  const root = vscode.workspace.workspaceFolders?.[0].uri
  if (root === undefined) return
  const env = new Environment(root)

  vscode.languages.registerCompletionItemProvider(
    'markdown',
    {
      async provideCompletionItems(document, position) {
        const tree = await env.treeP
        if (position.character < 2) return undefined
        const text = document.getText(
          new vscode.Range(new vscode.Position(position.line, 0), position)
        )
        const i = text.lastIndexOf('[[')
        const j = text.lastIndexOf(']]')
        if (i === -1 || j > i) return undefined

        return getAllSortedPathsFromTree(tree).map((path) => new vscode.CompletionItem(path))
      }
    },
    '['
  )

  const updateTree = async () => {
    env.treeP.set(await getTree(root))
  }

  vscode.workspace.onDidCreateFiles(updateTree)
  vscode.workspace.onDidDeleteFiles(updateTree)
  vscode.workspace.onDidRenameFiles(updateTree)

  const linkPattern = /(?<!(?:\\\\)*\\)\[\[(.+?)(?<!(\\\\)*\\)\]\]/g

  updateTree().then(() => {
    // reload after tree became ready
    vscode.commands.executeCommand('markdown.preview.refresh')

    vscode.languages.registerDocumentLinkProvider('markdown', {
      async provideDocumentLinks(document): Promise<vscode.DocumentLink[] | undefined> {
        const tree = await env.treeP

        const relativeCurrentPath = getRelativePath(document.uri.path, env.rootUri.path) ?? ''

        const text = document.getText()
        const links: vscode.DocumentLink[] = []

        for (const [i, line] of text.split('\n').entries()) {
          for (const { index, 0: whole, 1: name } of line.matchAll(linkPattern)) {
            if (index === undefined) continue

            const target = findPathFromTree(tree, name, relativeCurrentPath)

            links.push(
              new vscode.DocumentLink(
                new vscode.Range(
                  new vscode.Position(i, index),
                  new vscode.Position(i, index + whole.length)
                ),
                vscode.Uri.joinPath(root, `${target}.md`)
              )
            )
          }
        }

        return links
      }
    })
  })

  let provider: LinkTreeProvider | undefined
  function createOrRefreshLinksTree() {
    if (provider !== undefined) {
      provider.refresh()
      return
    }

    vscode.window.createTreeView('pageLinks', {
      treeDataProvider: (provider = new LinkTreeProvider(env))
    })
  }

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.languageId === 'markdown') {
      vscode.commands.executeCommand('setContext', 'vscode-wiki.showLinks', true)
      createOrRefreshLinksTree()
    } else {
      vscode.commands.executeCommand('setContext', 'vscode-wiki.showLinks', false)
    }
  })

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document === vscode.window.activeTextEditor?.document) {
      createOrRefreshLinksTree()
    }
  })

  if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
    vscode.commands.executeCommand('setContext', 'vscode-wiki.showLinks', true)
    createOrRefreshLinksTree()
  }

  return {
    extendMarkdownIt(md: MarkdownIt) {
      env.mdP.set(md)
      return md.use((md) => {
        md.inline.ruler.after('emphasis', 'wiki-link', (state, silent) => {
          if (state.src.slice(state.pos, state.pos + 2) !== '[[') return false

          const max = state.posMax
          const startPos = state.pos + 2
          let pos = startPos
          let ok = false

          while (pos < max) {
            if (pos + 1 < max && state.src.slice(pos, pos + 2) === ']]') {
              ok = true
              break
            }
            if (state.src.charAt(pos) === '\\' && pos + 1 < max) {
              pos += 2
            } else {
              pos += 1
            }
          }

          if (!ok) return false

          if (!silent) {
            const label = md.utils.unescapeAll(state.src.slice(startPos, pos))
            const token = state.push('wiki-link', 'a', 0)
            token.content = label
          }

          state.pos = pos + 2

          return true
        })

        md.renderer.rules['wiki-link'] = (
          tokens,
          index: number,
          _options,
          renderEnv: { currentDocument: vscode.Uri; [key: string]: any }
        ): string => {
          const tree = env.treeP.value
          const token = tokens[index]
          const currentPath = renderEnv.currentDocument.path
          const relativeCurrentPath = getRelativePath(currentPath, env.rootUri.path) ?? ''
          const targetPath =
            tree !== undefined ? findPathFromTree(tree, token.content, relativeCurrentPath) : ''
          return `<a href="${targetPath}.md" data-href="${targetPath}.md">${token.content}</a>`
        }
      })
    }
  }
}

export function deactivate() {}

type File = { name: string; children?: undefined; lastModified: number }
type Folder = { name: string; children: Tree }
type Node = Folder | File
type Tree = Node[]

const mdFilePattern = /(.+)\.md$/

async function getTree(parent: vscode.Uri): Promise<Tree> {
  const nodes: Tree = []
  for (const [name, fileType] of await vscode.workspace.fs.readDirectory(parent)) {
    if (name.startsWith('.')) continue

    switch (fileType) {
      case vscode.FileType.File: {
        const m = name.match(mdFilePattern)
        if (m !== null) {
          const s = await vscode.workspace.fs.stat(vscode.Uri.joinPath(parent, name))
          nodes.push({ name: m[1], lastModified: s.mtime })
        }
        break
      }
      case vscode.FileType.Directory: {
        const dirUri = parent.with({ path: path.join(parent.path, name) })
        nodes.push({
          name,
          children: await getTree(dirUri)
        })
        break
      }
    }
  }
  return nodes
}

function findPathFromTree(tree: Tree, name: string, currentDocPath: string): string {
  if (name.startsWith('/')) {
    return name
  }

  if (currentDocPath.startsWith('/')) {
    currentDocPath = currentDocPath.slice(1)
  }

  if (currentDocPath === '') {
    return `/${name}`
  }

  const nameElems = name.split('/')

  let currentTree = tree
  let currentPath = ''

  {
    const node = digTree(currentTree, nameElems)
    if (node !== undefined && node.children === undefined) {
      return `/${name}`
    }
  }

  for (const pathElem of currentDocPath.split('/')) {
    const node = digTree(currentTree, [pathElem])
    if (node === undefined || node.children === undefined) break

    currentTree = node.children
    currentPath += `/${pathElem}`

    const node2 = digTree(currentTree, nameElems)
    if (node2 !== undefined && node2.children === undefined) {
      return `${currentPath}/${name}`
    }
  }

  return `/${name}`
}

function digTree(tree: Tree, names: string[]): Node | undefined {
  if (names.length === 0) return undefined

  const [name, ...rest] = names
  const node = tree.find((n) => n.name === name)
  if (node === undefined) return undefined
  if (rest.length === 0) return node
  if (node.children === undefined) return undefined
  return digTree(node.children, rest)
}

function getRelativePath(path: string, basePath: string): string | undefined {
  if (path.startsWith(basePath)) {
    return path.slice(basePath.length)
  }
  return undefined
}

function getAllSortedPathsFromTree(tree: Tree): Array<string> {
  return [...getAllPathsFromTree(tree, '')]
    .sort((a, b) => a.lastModified - b.lastModified)
    .map(({ path }) => path)
}

function* getAllPathsFromTree(
  tree: Tree,
  parentPath: string = ''
): Iterable<{ path: string; lastModified: number }> {
  for (const node of tree) {
    const nodePath = path.join(parentPath, node.name)
    if (node.children === undefined) {
      yield { path: nodePath, lastModified: node.lastModified }
    } else {
      yield* getAllPathsFromTree(node.children, nodePath)
    }
  }
}

type LinkTreeItem =
  | { type: 'header-outgoing' }
  | { type: 'header-incoming' }
  | { type: 'link'; name: string }
class LinkTreeProvider implements vscode.TreeDataProvider<LinkTreeItem> {
  private callbacks = new Set<(e: void | LinkTreeItem | null | undefined) => void>()

  constructor(private env: Environment) {}

  refresh() {
    for (const f of this.callbacks) {
      f(undefined)
    }
  }

  onDidChangeTreeData(
    callback: (e: void | LinkTreeItem | null | undefined) => void,
    disposables?: Array<vscode.Disposable>
  ): vscode.Disposable {
    this.callbacks.add(callback)

    const disposable: vscode.Disposable = {
      dispose: () => {
        this.callbacks.delete(callback)
      }
    }
    disposables?.push(disposable)
    return disposable
  }

  async getChildren(element?: LinkTreeItem): Promise<LinkTreeItem[] | undefined> {
    switch (element?.type) {
      case undefined:
        return [{ type: 'header-outgoing' }, { type: 'header-incoming' }]

      case 'header-incoming': {
        const tree = await this.env.treeP
        const md = await this.env.mdP
        const paths = Array.from(getAllPathsFromTree(tree)).map(({ path }) => path)
        const workspaceUri = vscode.workspace.workspaceFolders?.[0].uri
        if (workspaceUri === undefined) return
        const selfUri = vscode.window.activeTextEditor?.document.uri
        if (
          selfUri === undefined ||
          !selfUri.path.startsWith(workspaceUri.path) ||
          !selfUri.path.endsWith('.md')
        )
          return
        const selfPath = path.relative(workspaceUri.path, selfUri.path).slice(0, -3)
        const links = new Set<string>()
        for (const p of paths) {
          const tokens: Token[] = md.parse(
            new TextDecoder().decode(
              await vscode.workspace.fs.readFile(
                workspaceUri.with({ path: path.join(workspaceUri.path, p) + '.md' })
              )
            ),
            {}
          )
          for (const link of enumerateLinks(tokens)) {
            if (link === selfPath) {
              links.add(p)
            }
          }
        }
        return Array.from(links).map((link) => ({ type: 'link', name: link }))
      }

      case 'header-outgoing': {
        const md = await this.env.mdP
        const workspaceUri = vscode.workspace.workspaceFolders?.[0].uri
        if (workspaceUri === undefined) return
        const activeDocument = vscode.window.activeTextEditor?.document
        if (activeDocument === undefined) return
        const content = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(activeDocument.uri)
        )
        const tokens = md.parse(content, {})
        const links = Array.from(enumerateLinks(tokens))
        return links.map((link) => ({ type: 'link', name: link }))
      }
    }
  }

  getTreeItem(element: LinkTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    switch (element.type) {
      case 'header-incoming':
        return {
          label: 'Incoming Links',
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        }

      case 'header-outgoing':
        return {
          label: 'Outgoing Links',
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        }

      case 'link': {
        const workspaceUri = vscode.workspace.workspaceFolders?.[0].uri
        if (workspaceUri === undefined) throw new Error('no workspace')

        return {
          label: element.name,
          command: {
            title: '',
            command: 'vscode.open',
            arguments: [
              workspaceUri.with({ path: path.join(workspaceUri.path, element.name) + '.md' })
            ]
          }
        }
      }
    }
  }
}

function* enumerateLinks(tokens: Token[]): Iterable<string> {
  for (const token of tokens) {
    if (token.type === 'wiki-link') {
      yield token.content
      continue
    }
    if (token.children) {
      yield* enumerateLinks(token.children)
    }
  }
}
