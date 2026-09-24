// Constraint 10 (S6): nothing the Host bundle can reach imports electron, chokidar, or a file under
// src/main or src/renderer. The Host runs on plain node.exe, where `electron` is not a module and
// src/main is not shipped. Walks the real graph from every non-test file in src/host, following
// relative imports (value imports only: `import type` is erased by the compiler).
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC =
  /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gm

const resolveFrom = (file: string, spec: string): string | null => {
  const base = path.resolve(path.dirname(file), spec)
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base])
    if (existsSync(c) && /\.(ts|tsx|js|mjs|cjs)$/.test(c)) return c
  return null
}

/** Every violation reachable from `starts`, each as the chain of files that reaches it. */
export function fenceViolations(srcRoot: string, starts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const m of text.matchAll(SPEC)) {
      if (m[2]) continue // `import type` / `export type`
      const spec = m[3] ?? m[4] ?? m[5] ?? m[6]
      if (!spec) continue
      const here = [...chain, path.relative(srcRoot, file)]
      if (spec === 'electron' || spec.startsWith('electron/') || spec === 'chokidar' || spec.startsWith('chokidar/')) {
        out.push(`${here.join(' -> ')} -> ${spec}`)
        continue
      }
      if (!spec.startsWith('.')) continue
      const r = resolveFrom(file, spec)
      if (!r) continue
      const top = path.relative(srcRoot, r).split(path.sep)[0]
      if (top === 'main' || top === 'renderer') {
        out.push(`${here.join(' -> ')} -> ${path.relative(srcRoot, r)}`)
        continue
      }
      walk(r, here)
    }
  }
  for (const s of starts) walk(s, [])
  return out
}

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '..')

describe('the Host import fence (constraint 10)', () => {
  it('nothing reachable from src/host imports electron, chokidar, src/main or src/renderer', () => {
    const starts = readdirSync(here)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(here, f))
    expect(starts.length).toBeGreaterThan(10)
    expect(fenceViolations(srcRoot, starts)).toEqual([])
  })

  it('catches each kind of violation, through a chain, and ignores type-only imports', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-fence-'))
    try {
      for (const d of ['host', 'core', 'main']) mkdirSync(path.join(dir, d))
      writeFileSync(path.join(dir, 'host', 'a.ts'), "import { b } from '../core/b'\nimport type { X } from '../main/x'\n")
      writeFileSync(path.join(dir, 'core', 'b.ts'), "import { net } from 'electron'\nexport { c } from './c'\n")
      writeFileSync(path.join(dir, 'core', 'c.ts'), "import w from 'chokidar'\nimport { m } from '../main/m'\n")
      writeFileSync(path.join(dir, 'main', 'm.ts'), 'export const m = 1\n')
      writeFileSync(path.join(dir, 'main', 'x.ts'), 'export type X = 1\n')
      const v = fenceViolations(dir, [path.join(dir, 'host', 'a.ts')])
      expect(v).toHaveLength(3)
      expect(v.join('\n')).toMatch(/electron/)
      expect(v.join('\n')).toMatch(/chokidar/)
      expect(v.join('\n')).toMatch(/main[\\/]m\.ts/)
      expect(v.join('\n')).not.toMatch(/main[\\/]x\.ts/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
