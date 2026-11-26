// Which TypeScript a project uses (Phase 3 Part 3), so one below TypeScript 6 is checked by the TypeScript 5 server: the
// version of the copy installed in its node_modules first, else the first number of the range its package.json declares.
// Files are read as data; nothing of the project runs.
import path from 'node:path'

const majorOf = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const m = /(\d+)/.exec(v)
  // A protocol (`workspace:`, `npm:`, `file:`) names no version of its own
  return m && !/^[a-z]+:/i.test(v.trim()) ? Number(m[1]) : null
}

const json = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function projectTypescriptMajor(root: string, read: (p: string) => Promise<string | null>): Promise<number | null> {
  const installed = json(await read(path.join(root, 'node_modules', 'typescript', 'package.json')))
  const fromInstalled = majorOf(installed?.version)
  if (fromInstalled !== null) return fromInstalled
  const pkg = json(await read(path.join(root, 'package.json')))
  const deps = (k: string): Record<string, unknown> => (typeof pkg?.[k] === 'object' && pkg?.[k] !== null ? (pkg[k] as Record<string, unknown>) : {})
  return majorOf(deps('devDependencies').typescript) ?? majorOf(deps('dependencies').typescript)
}
