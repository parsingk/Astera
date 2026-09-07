import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// tsconfig.web.json cannot glob src/core the way it globs the renderer itself: a glob would pull
// node-only core modules (fs, child_process, ...) into a DOM-lib project and break the renderer build.
// So it names each core file the renderer is allowed to import instead, by hand.
//
// That list has fallen behind three times now -- three separate slices of work each lost time to a
// confusing typecheck error deep into unrelated changes, because a new core file the renderer had
// started importing was never added to it. This test turns the same mistake into an immediate, obvious
// failure instead: it walks every renderer source file, resolves every relative import that lands under
// src/core, and asserts each one is named in tsconfig.web.json's include array.
//
// Resolution mirrors what a bundler does with a relative specifier: join it against the importing
// file's directory, then try the file's own extension before an index file. Kept simple over clever --
// a specifier this cannot resolve to a real file on disk is left alone rather than guessed at.

const RENDERER_ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(RENDERER_ROOT, '..', '..')
const EXTS = /\.tsx?$/
// Catches `import ... from '...'`, `import type ... from '...'`, `export ... from '...'` and a bare
// `import '...'` alike -- all of them put the specifier right after `from` or `import`, in quotes.
const IMPORT_RE = /(?:from|import)\s+['"](\.[^'"]+)['"]/g

function collect(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collect(full, out)
    else if (EXTS.test(e.name)) out.push(full)
  }
  return out
}

/** `specifier` resolved against the directory of the file that imports it, as a repo-relative POSIX
 *  path carrying its real extension -- or null if none of the candidates exist on disk (a package
 *  import, or a relative import of something other than a TypeScript module). */
function resolveImport(specifier: string, fromDir: string): string | null {
  const base = path.resolve(fromDir, specifier)
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  const hit = candidates.find((c) => existsSync(c))
  return hit ? path.relative(REPO_ROOT, hit).replace(/\\/g, '/') : null
}

function findViolations(webInclude: readonly string[]): string[] {
  const included = new Set(webInclude)
  const violations: string[] = []
  for (const file of collect(RENDERER_ROOT, [])) {
    const dir = path.dirname(file)
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const resolved = resolveImport(m[1], dir)
      if (!resolved || !resolved.startsWith('src/core/')) continue // not a core module
      if (!included.has(resolved)) violations.push(`${rel} imports ${resolved}, missing from tsconfig.web.json's include`)
    }
  }
  return violations
}

describe('every core module the renderer imports is listed in tsconfig.web.json', () => {
  it("appears in the include array (a glob would pull node-only core into the renderer's DOM project)", () => {
    const tsconfig = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tsconfig.web.json'), 'utf8')) as { include: string[] }
    // A failure here means: add the newly cited path to tsconfig.web.json's include array.
    expect(findViolations(tsconfig.include)).toEqual([])
  })
})
