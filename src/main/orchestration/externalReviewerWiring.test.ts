// Text guards over the app's external reviewer wiring (src/main/ipc.ts, src/preload/index.ts). The logic is in src/core
// (review.ts, externalReview.ts, probe.ts) and tested there; these pin what only ipc.ts can get wrong.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const ipc = readFileSync(path.resolve(here, '../ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(here, '../../preload/index.ts'), 'utf8')

function between(start: string, end: string): string {
  const a = ipc.indexOf(start)
  if (a < 0) throw new Error(`marker not found: ${start}`)
  const b = ipc.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`end marker not found: ${end}`)
  return ipc.slice(a, b)
}

describe('the app runs external reviews as its own child', () => {
  const starter = between('const startReview = createReviewStarter({', 'const reapCtx')
  it('spawns with the core nodeProcFactory and settles through the in-process door', () => {
    expect(starter).toMatch(/external: \{/)
    expect(starter).toMatch(/spawn: nodeProcFactory/)
    expect(starter).toMatch(/handle: \(cmd, args\) => orchHandleCommand\(deps, \{ sessionId: UI_CALLER \}, cmd, args\)/)
    expect(starter).toMatch(/rangeDiff: \(cwd, base, head, o\) => readRangeDiff\(cwd, base, head, o\)/)
  })
  it('kills its external reviews synchronously when the orchestration stops (quit)', () => {
    const stop = between('orchWiring?.onStarted({', 'onRolled:')
    expect(stop).toMatch(/startReview\.disposeExternal\(\)/)
    expect(stop).not.toMatch(/await|\.then\(/)
  })
})

describe('settings.testExternalReviewer', () => {
  const handler = between("ipcMain.handle('settings.testExternalReviewer'", "ipcMain.handle('settings.getMcpAccess'")
  it('answers a malformed reviewer before any folder is made or process started', () => {
    const invalid = handler.indexOf("message: 'invalid reviewer'")
    expect(invalid).toBeGreaterThan(0)
    expect(invalid).toBeLessThan(handler.indexOf('mkdtemp'))
    expect(invalid).toBeLessThan(handler.indexOf('probeReviewer('))
    expect(handler).toMatch(/r\.args\.length <= 20/)
    expect(handler).toMatch(/typeof x === 'string'/)
  })
  it('removes its temporary folder in a finally and uses the core factory', () => {
    expect(handler).toMatch(/finally \{\s*await fs\.rm\(cwd/)
    expect(handler).toMatch(/spawn: nodeProcFactory/)
  })
  it('is reachable from the renderer', () => {
    expect(preload).toMatch(/testExternalReviewer: invoke\('settings\.testExternalReviewer'\)/)
  })
})
