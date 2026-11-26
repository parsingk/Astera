// The "언어 서버" settings from app-settings.json (Phase 3 Part 3): read by the Host when it starts a server, written by
// main's settings store. One narrowing for both, so the two cannot differ: each language is on unless it says `false`, a
// path or an interpreter is kept only when absolute, and the projects whose virtual environment the person allowed are
// absolute paths.
import path from 'node:path'
import type { LanguageServerSettings } from '../lsp/model'
import { readAppSettingsObject } from './settingsObject'

export type { LanguageServerSettings }

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const absolute = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' && path.isAbsolute(v) ? v : undefined)

export function languageServersOf(value: unknown): LanguageServerSettings {
  const o = obj(value)
  const ts = obj(o.typescript)
  const py = obj(o.python)
  const tsPath = absolute(ts.path)
  const pyPath = absolute(py.path)
  const interpreter = absolute(py.interpreter)
  return {
    typescript: { enabled: ts.enabled !== false, ...(tsPath !== undefined ? { path: tsPath } : {}) },
    python: {
      enabled: py.enabled !== false,
      ...(pyPath !== undefined ? { path: pyPath } : {}),
      ...(interpreter !== undefined ? { interpreter } : {}),
      venvProjects: Array.isArray(py.venvProjects) ? py.venvProjects.filter((p): p is string => absolute(p) !== undefined) : []
    }
  }
}

/** Missing file: the defaults. Unreadable file: throws (readAppSettingsObject's rule). */
export async function readLanguageServers(filePath: string): Promise<LanguageServerSettings> {
  const parsed = await readAppSettingsObject(filePath)
  return languageServersOf(parsed?.languageServers)
}

/** Why a path cannot replace Astera's install, or null: it must be absolute and name what Astera runs, TypeScript 7's
 *  native `tsc` for TypeScript, pyright's `langserver.index.js` for Python. */
export function languageServerPathProblem(server: 'typescript' | 'python', p: string): string | null {
  if (!path.isAbsolute(p)) return `not an absolute path: ${p}`
  const name = path.basename(p).toLowerCase()
  if (server === 'typescript' && name !== 'tsc' && name !== 'tsc.exe') return `not TypeScript 7's tsc: ${p}`
  if (server === 'python' && name !== 'langserver.index.js') return `not pyright's langserver.index.js: ${p}`
  return null
}
