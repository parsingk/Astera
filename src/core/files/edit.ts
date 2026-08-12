// Extension -> CodeMirror 6 language key. Only the languages @codemirror/lang-* covers.
export type LangKey =
  | 'javascript' | 'python' | 'json' | 'css' | 'html' | 'markdown'
  | 'rust' | 'cpp' | 'java' | 'php' | 'sql' | 'xml' | 'yaml' | 'go'

const LANG_BY_EXT: Record<string, LangKey> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript',
  py: 'python', pyw: 'python',
  json: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  rs: 'rust', c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp',
  java: 'java', php: 'php', sql: 'sql',
  xml: 'xml', svg: 'xml', go: 'go',
  yml: 'yaml', yaml: 'yaml'
}

/** Picks the CM6 language key from a file path's extension. null (plain) when there is no extension or it is unknown. */
export function languageForExt(path: string): LangKey | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return LANG_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null
}

/** Decides what to do with an external-change event. Our own save (disk == the saved copy) is
 *  ignored; an unmodified buffer reloads; a modified one gets the conflict banner. */
export function classifyExternalChange(
  diskContent: string,
  savedContent: string,
  dirty: boolean
): 'ignore' | 'reload' | 'conflict' {
  if (diskContent === savedContent) return 'ignore'
  return dirty ? 'conflict' : 'reload'
}

/** Whether two texts are the same document, ignoring how their lines end.
 *
 *  CodeMirror normalises line endings to LF when it builds a document, while the buffer App holds is
 *  whatever came off disk — CRLF for most files written on Windows. A plain === between the two
 *  therefore never holds for such a file, which silently disabled every reuse of a cached EditorState:
 *  undo history and scroll position were rebuilt from scratch on each remount. Lone CR (classic Mac)
 *  is folded too, because CodeMirror splits on that as well.
 *
 *  The identity check comes first so LF files, the common case, never pay for the normalisation. */
export function sameDocument(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

/** The line ending a file uses on disk. */
export type Eol = '\r\n' | '\n'

/** Which line ending dominates the text. Mixed files pick the majority rather than the first hit, so a
 *  single stray CRLF in an LF file does not convert the whole file on the next save. Text with no line
 *  break at all reports LF, which is harmless: applying it changes nothing. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length
  if (crlf === 0) return '\n'
  const lone = (text.match(/(^|[^\r])\n/g) ?? []).length
  return crlf > lone ? '\r\n' : '\n'
}

/** Rewrites every line ending to LF. Everything above the filesystem boundary works in LF: CodeMirror
 *  normalises documents that way, so keeping the buffer in the same shape is what lets a document be
 *  compared with, and reused against, the editor's own state. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Rewrites LF text back to the file's own line ending, for the moment it is written to disk. Without
 *  this a CRLF file is silently converted to LF by the first save, which shows up as every line having
 *  changed. */
export function applyEol(text: string, eol: Eol): string {
  return eol === '\n' ? toLf(text) : toLf(text).replace(/\n/g, '\r\n')
}
