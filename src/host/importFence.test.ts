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
  // `./x.js` names `./x.ts`, the way the bundler's resolution reads it.
  const js = /\.(m|c)?js$/.exec(base)
  const source = js ? [base.slice(0, -js[0].length) + '.ts', base.slice(0, -js[0].length) + '.tsx'] : []
  for (const c of [...source, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base])
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
    // Line comments only. A block-comment strip reads the `/*` in a string such as a glob as a
    // comment's start and removes every import up to the next `*/` (review of Task 1).
    const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')
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
      // A file the walk cannot find is a file it did not read, so it cannot be called clean.
      if (!r) {
        out.push(`${here.join(' -> ')} -> ${spec} (unresolved)`)
        continue
      }
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

  // Review of Task 1: a relative import the walk cannot find is a file it did not read, so it must
  // not pass. A `.js` specifier names its `.ts` source, as the bundler resolves it.
  it('reports a relative import it cannot resolve, and follows a .js specifier to its .ts source', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-fence-'))
    try {
      for (const d of ['host', 'core']) mkdirSync(path.join(dir, d))
      writeFileSync(path.join(dir, 'host', 'a.ts'), "import { a } from '../main/host/client.js'\nimport { b } from '../core/b.js'\n")
      writeFileSync(path.join(dir, 'core', 'b.ts'), "import { net } from 'electron'\nexport const b = net\n")
      const v = fenceViolations(dir, [path.join(dir, 'host', 'a.ts')])
      expect(v).toHaveLength(2)
      expect(v.join('\n')).toMatch(/main\/host\/client\.js/)
      expect(v.join('\n')).toMatch(/core[\\/]b\.ts -> electron/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Review of Task 1: a `/*` inside a string is not a comment. Stripping block comments ran from it
  // to the next `*/` and hid the require between them.
  it('does not lose an import behind a string that contains /*', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-fence-'))
    try {
      mkdirSync(path.join(dir, 'host'))
      writeFileSync(path.join(dir, 'host', 'a.ts'), "export const glob = 'src/*'\nrequire('electron')\n/** doc */\nexport const x = 1\n")
      expect(fenceViolations(dir, [path.join(dir, 'host', 'a.ts')])).toEqual([`${path.join('host', 'a.ts')} -> electron`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Chat takeover Task 1 (spec §3.1): the adapters the Host runs live in core, inside the fence.
  it('the chat adapters live in core/chat and are inside the fence', () => {
    const moved = ['manager.ts', 'adapterCore.ts', 'claudeAdapter.ts', 'codexAdapter.ts'].map((f) =>
      path.join(srcRoot, 'core', 'chat', f)
    )
    for (const f of moved) expect(existsSync(f), f).toBe(true)
    expect(existsSync(path.join(srcRoot, 'main', 'chat', 'manager.ts'))).toBe(false)
    // nodeProcFactory stays with the app: it is the no-Host fallback.
    expect(existsSync(path.join(srcRoot, 'main', 'chat', 'nodeProcFactory.ts'))).toBe(true)
    expect(fenceViolations(srcRoot, moved)).toEqual([])
  })
})
