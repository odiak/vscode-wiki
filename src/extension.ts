import * as vscode from 'vscode'
import * as MarkdownIt from 'markdown-it'

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

        md.renderer.rules['wiki-link'] = (tokens, index: number): string => {
          const token = tokens[index]
          return `<a href="${token.content}.md">${token.content}</a>`
        }
      })
    }
  }
}

export function deactivate() {}
