import * as vscode from 'vscode'
import * as MarkdownIt from 'markdown-it'
import * as path from 'path'

export function activate(context: vscode.ExtensionContext) {
  // if (!vscode.workspace.getConfiguration('vscode-wiki').get<boolean>('enabled')) return

  vscode.languages.registerCompletionItemProvider(
    'markdown',
    {
      provideCompletionItems(document, position) {
        if (position.character < 2) return undefined
        const text = document.getText(
          new vscode.Range(new vscode.Position(position.line, 0), position)
        )
        const i = text.lastIndexOf('[[')
        const j = text.lastIndexOf(']]')
        if (i === -1 || j > i) return undefined

        return [
          new vscode.CompletionItem('Foobar'),
          new vscode.CompletionItem('Fooban'),
          new vscode.CompletionItem('Foorin')
        ]
      },
      resolveCompletionItem(item) {
        return undefined
      }
    },
    '['
  )

  let tree: Tree | undefined = undefined
  async function updateTree() {
    tree = await getTree()
  }

  updateTree()

  vscode.workspace.onDidCreateFiles(updateTree)
  vscode.workspace.onDidDeleteFiles(updateTree)
  vscode.workspace.onDidRenameFiles(updateTree)

  const rootPath = vscode.workspace.workspaceFolders?.[0].uri.path

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
          const relativeCurrentPath =
            rootPath !== undefined && currentPath.startsWith(rootPath)
              ? currentPath.slice(rootPath.length)
              : '/'
          const targetPath =
            tree !== undefined ? findPathFromTree(tree, token.content, relativeCurrentPath) : ''
          return `<a href="${targetPath}.md" data-href="${targetPath}.md">${token.content}</a>`
        }
      })
    }
  }
}

export function deactivate() {}

type File = { name: string; children?: undefined }
type Folder = { name: string; children: Tree }
type Node = Folder | File
type Tree = Node[]

const mdFilePattern = /(.+)\.md$/

async function getTree(parent?: vscode.Uri): Promise<Tree> {
  parent ??= vscode.workspace.workspaceFolders?.[0].uri
  if (parent === undefined) return []

  const nodes: Tree = []
  for (const [name, fileType] of await vscode.workspace.fs.readDirectory(parent)) {
    switch (fileType) {
      case vscode.FileType.File: {
        const m = name.match(mdFilePattern)
        if (m !== null) {
          nodes.push({ name: m[1] })
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
