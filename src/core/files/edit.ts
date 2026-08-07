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
