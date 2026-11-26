// Which language a file is, and each server's name as a person reads it (Phase 3 Part 3). No Node imports: the renderer
// reads this too (listed in tsconfig.web), to say which open files go to a server and to title the settings rows.
import type { LspLanguage, LspServerId } from './model'

export const LSP_SERVERS: Readonly<Record<LspServerId, { language: LspLanguage; title: string }>> = {
  typescript: { language: 'typescript', title: 'TypeScript' },
  typescript5: { language: 'typescript', title: 'TypeScript 5' },
  python: { language: 'python', title: 'Python' }
}

const BY_EXTENSION: Readonly<Record<string, LspLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  py: 'python',
  pyi: 'python'
}

/** The language a file's extension names, in any case; null for any other file. */
export function languageOf(p: string): LspLanguage | null {
  const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}
