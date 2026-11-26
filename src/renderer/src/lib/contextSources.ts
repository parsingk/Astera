import { contentRevision, relativeTo, type ContextRef } from '../../../core/context/contextRef'
import { isCredentialFile } from '../../../core/files/textMatch'
import type { Diagnostic } from '../../../core/problems/diagnostic'

/**
 * A run's log as a piece of context (spec W4 "log → context preview"): what is selected in its console, or, with nothing
 * selected, the end of its log, which is what a person sending a failing run means. Its folder is the run's project.
 */
export function logContext(input: {
  run: { runId: string; projectPath: string; configName: string }
  selection: string
  tail: readonly string[]
}): { ok: true; ref: ContextRef; excerpt: string; fromTail: boolean } | { ok: false; reason: 'empty' } {
  const fromTail = input.selection.trim() === ''
  const excerpt = fromTail ? input.tail.join('\n').replace(/\s+$/, '') : input.selection
  if (excerpt.trim() === '') return { ok: false, reason: 'empty' }
  return {
    ok: true,
    ref: { schemaVersion: 1, kind: 'log', root: input.run.projectPath, sourceId: input.run.runId, label: `Run: ${input.run.configName}` },
    excerpt,
    // A tail is sent for its end, where the failure is: contextText keeps the end when it has to cut (keepEnd)
    fromTail
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

/** How many lines before and after a problem an agent receives with it. */
const PROBLEM_CONTEXT_LINES = 3

/** What a problem says, as one line: its severity, its place, who found it, and its words (or what stands for them). */
function problemLine(d: Diagnostic, root: string): string {
  const where = d.path !== undefined ? `${relativeTo(root, d.path)}${d.line !== undefined ? `:${d.line}` : ''} ` : ''
  const words =
    d.message !== ''
      ? d.message
      : d.unlisted !== undefined
        ? `${d.unlisted} more finding(s) this check did not list`
        : 'the check failed'
  return `${d.severity} ${where}${d.source.label}: ${words}`
}

/** The lines around a problem, numbered, its own marked with `>`. */
function problemLines(text: string, line: number, endLine: number): string[] {
  const lines = text.split(/\r?\n/)
  const first = Math.max(1, line - PROBLEM_CONTEXT_LINES)
  const last = Math.min(lines.length, endLine + PROBLEM_CONTEXT_LINES)
  const width = String(last).length
  const out: string[] = []
  for (let n = first; n <= last; n++) out.push(`${n >= line && n <= endLine ? '  > ' : '    '}${String(n).padStart(width)} | ${lines[n - 1]}`)
  return out
}

/**
 * Problems rows as a piece of context (Phase 3 Part 1, "send to an agent"): each problem as one line (severity, place,
 * who found it, its words) followed by the lines around it from `files` (the files as read from disk now, by path), so
 * the agent sees what the person saw. One row is a piece of its file, with its lines and the file's revision, which the
 * paste checks again; several rows are a piece of the project. A credential file's lines are never included
 * (isCredentialFile, as for a selection): its problem goes by its words alone.
 */
export function problemsContext(input: {
  rows: readonly Diagnostic[]
  root: string
  files: Readonly<Record<string, string>>
}): { ok: true; ref: ContextRef; excerpt: string; language: string } | { ok: false; reason: 'empty' } {
  if (input.rows.length === 0) return { ok: false, reason: 'empty' }
  /** The file's text when its lines may be sent, else undefined. */
  const readable = (d: Diagnostic): string | undefined =>
    d.path !== undefined && d.line !== undefined && !isCredentialFile(relativeTo(input.root, d.path)) ? input.files[d.path] : undefined
  const blocks = input.rows.map((d) => {
    const text = readable(d)
    const head = problemLine(d, input.root)
    return text === undefined ? head : [head, ...problemLines(text, d.line as number, d.endLine ?? (d.line as number))].join('\n')
  })
  const excerpt = blocks.join('\n\n')
  if (input.rows.length > 1) return { ok: true, ref: { schemaVersion: 1, kind: 'diagnostic', root: input.root, label: `${input.rows.length} problems` }, excerpt, language: '' }
  const d = input.rows[0]
  const text = readable(d)
  const ref: ContextRef = {
    schemaVersion: 1,
    kind: 'diagnostic',
    root: input.root,
    ...(d.path !== undefined ? { path: d.path } : {}),
    ...(d.line !== undefined ? { range: { startLine: d.line, endLine: d.endLine ?? d.line } } : {}),
    // Only for lines that are sent: the paste checks them again against the file on disk
    ...(text !== undefined ? { revision: contentRevision(text) } : {}),
    sourceId: d.ref ?? d.id,
    label: `${d.path !== undefined ? `${relativeTo(input.root, d.path)}${d.line !== undefined ? `:${d.line}` : ''} ` : ''}${d.source.label}`
  }
  return { ok: true, ref, excerpt, language: '' }
}
