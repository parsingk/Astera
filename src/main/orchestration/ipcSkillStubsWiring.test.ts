// Text guard for src/main/ipc.ts, the same kind as ipcConvergenceWiring.test.ts: ipc.ts has no unit
// tests of its own, so this is the only place that can see what `installStubsForCurrentToggles`
// builds its list from.
//
// **Why it matters (design R2.2).** The app and `astera skills install` must install the same set of
// skills behind the same gates, and they do only because both build from `skillStubs()` in stub.ts.
// An inline list reintroduced here would compile, pass every other test, and quietly let the two
// drift apart.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ipcSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ipc.ts'), 'utf8')

/** The function's text, comments removed so a comment cannot satisfy the checks. Throws when the
 *  markers move rather than silently scanning the wrong span. */
function installerBody(): string {
  const startMarker = 'const installStubsForCurrentToggles = (): void => {'
  const start = ipcSource.indexOf(startMarker)
  if (start < 0) throw new Error('installStubsForCurrentToggles not found in ipc.ts')
  const end = ipcSource.indexOf('\n  }\n', start)
  if (end < 0) throw new Error('end of installStubsForCurrentToggles not found in ipc.ts')
  return ipcSource
    .slice(start, end)
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

describe('ipc.ts skill stub wiring (source guard)', () => {
  it('installStubsForCurrentToggles builds its list from skillStubs()', () => {
    const body = installerBody()
    expect(body).toMatch(/skillStubs\(\s*orch\.skillsPath\s*,/)
    expect(body).toMatch(/\.filter\(\s*\(s\)\s*=>\s*s\.enabled\s*\)/)
  })

  it('names no stub file or skill directory of its own', () => {
    const body = installerBody()
    for (const name of ['-stub.md', 'astera-orchestration', 'astera-task', 'astera-browser', 'astera-handoff'])
      expect(body.includes(name), `${name} appears in installStubsForCurrentToggles`).toBe(false)
  })
})
