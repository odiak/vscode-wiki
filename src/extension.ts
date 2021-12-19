import * as vscode from 'vscode'
import * as MarkdownIt from 'markdown-it'
import * as path from 'path'

export function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.getConfiguration('vscode-wiki').get<boolean>('enabled')) return

  const root = vscode.workspace.workspaceFolders?.[0].uri
  if (root === undefined) return
  const rootPath = root.path

  vscode.languages.registerCompletionItemProvider(
    'markdown',
    {
      provideCompletionItems(document, position) {
        if (tree === undefined) return undefined
        if (position.character < 2) return undefined
        const text = document.getText(
          new vscode.Range(new vscode.Position(position.line, 0), position)
        )
        const i = text.lastIndexOf('[[')
        const j = text.lastIndexOf(']]')
        if (i === -1 || j > i) return undefined

        return getAllSortedPathsFromTree(tree).map((path) => new vscode.CompletionItem(path))
      },
      resolveCompletionItem(item) {
        return undefined
      }
    },
    '['
  )

  let tree: Tree | undefined = undefined
  const updateTree = async () => {
    tree = await getTree(root)
  }

  vscode.workspace.onDidCreateFiles(updateTree)
  vscode.workspace.onDidDeleteFiles(updateTree)
  vscode.workspace.onDidRenameFiles(updateTree)

  const linkPattern = /(?<!(?:\\\\)*\\)\[\[(.+?)(?<!(\\\\)*\\)\]\]/g

  updateTree().then(() => {
    // reload after tree became ready
    vscode.commands.executeCommand('markdown.preview.refresh')

    vscode.languages.registerDocumentLinkProvider('markdown', {
      provideDocumentLinks(document): vscode.DocumentLink[] | undefined {
        if (tree === undefined) return undefined

        const relativeCurrentPath = getRelativePath(document.uri.path, rootPath) ?? ''

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

  return {
    extendMarkdownIt(md: MarkdownIt) {
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
          env: { currentDocument: vscode.Uri; [key: string]: any }
        ): string => {
          const token = tokens[index]
          const currentPath = env.currentDocument.path
          const relativeCurrentPath = getRelativePath(currentPath, rootPath) ?? ''
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
