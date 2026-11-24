import { contentRevision, relativeTo, type ContextRef } from '../../../core/context/contextRef'
import { isCredentialFile } from '../../../core/files/textMatch'

/**
 * A run's log as a piece of context (spec W4 "log → context preview"): what is selected in its console, or, with nothing
 * selected, the end of its log, which is what a person sending a failing run means. Its folder is the run's project.
 */
export function logContext(input: {
  run: { runId: string; projectPath: string; configName: string }
  selection: string
  tail: readonly string[]
}): { ok: true; ref: ContextRef; excerpt: string } | { ok: false; reason: 'empty' } {
  const excerpt = input.selection.trim() !== '' ? input.selection : input.tail.join('\n').replace(/\s+$/, '')
  if (excerpt.trim() === '') return { ok: false, reason: 'empty' }
  return {
    ok: true,
    ref: { schemaVersion: 1, kind: 'log', root: input.run.projectPath, sourceId: input.run.runId, label: `Run: ${input.run.configName}` },
    excerpt
  }
}

/** How many line breaks come before `at` in `text`. */
const breaksBefore = (text: string, at: number): number => {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * An editor selection as a piece of context (spec W4 "editor selection → session"): the selected text, the lines it
 * covers, and the revision of the file as saved, which is what the agent will read. `doc` is the editor's text and
 * `saved` the file's as last read or written (both with `\n` line ends, as the buffer keeps them); a difference means
 * unsaved edits (`dirty`), which the preview warns of.
 *
 * Refused: an empty or blank selection, and any selection in a credential file (core/files/textMatch.ts
 * isCredentialFile), whose content is not sent at all since no masking knows every secret format.
 */
export function selectionContext(input: {
  path: string
  root: string
  doc: string
  saved: string
  from: number
  to: number
}):
  | { ok: true; ref: ContextRef; excerpt: string; language: string; dirty: boolean }
  | { ok: false; reason: 'empty' | 'credential' } {
  const from = Math.min(input.from, input.to)
  const to = Math.max(input.from, input.to)
  const excerpt = input.doc.slice(from, to)
  if (excerpt.trim() === '') return { ok: false, reason: 'empty' }
  const rel = relativeTo(input.root, input.path)
  if (isCredentialFile(rel)) return { ok: false, reason: 'credential' }
  const startLine = breaksBefore(input.doc, from) + 1
  // A selection of whole lines ends just after a line break; the line after it is not part of it
  const endLine = breaksBefore(input.doc, to) + 1 - (input.doc[to - 1] === '\n' ? 1 : 0)
  const name = input.path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return {
    ok: true,
    ref: {
      schemaVersion: 1,
      kind: 'selection',
      root: input.root,
      path: input.path,
      range: { startLine, endLine },
      revision: contentRevision(input.saved),
      label: `${rel}:${startLine === endLine ? startLine : `${startLine}-${endLine}`}`
    },
    excerpt,
    language: /^[a-z0-9+#-]+$/.test(ext) ? ext : '',
    dirty: input.doc !== input.saved
  }
}
