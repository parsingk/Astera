// Which of the editor's tabs go to the Host's language servers (Phase 3 Part 3): the TS/JS and Python files, once each,
// with the project root the tab was opened under.
import { languageOf } from '../../../core/lsp/languages'
import type { LspOpenFile } from '../../../core/lsp/model'

export function lspOpenFiles(tabs: readonly { path: string; projectRoot: string }[]): LspOpenFile[] {
  const seen = new Set<string>()
  const out: LspOpenFile[] = []
  for (const tab of tabs) {
    if (languageOf(tab.path) === null || seen.has(tab.path)) continue
    seen.add(tab.path)
    out.push({ path: tab.path, root: tab.projectRoot })
  }
  return out
}
