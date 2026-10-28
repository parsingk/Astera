// How the app wires the codex rollout checks (Task D and its minors). index.ts and ipc.ts cannot run without Electron, so
// the wiring is guarded by their text, as sessionDriver.wiring.test.ts guards the pty driver's.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')
const index = readFileSync(path.join(here, 'index.ts'), 'utf8')

/** The text of the call that starts at `start`, up to `end`. */
const block = (src: string, start: string, end: string): string => {
  const at = src.indexOf(start)
  expect(at).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf(end, at))
}

// Task D review Minor 5: the app's rollout watcher and codex coordinator ask whose codex holds a rollout about the
// session's pty process. Lost, either went back to folder and time without a word (each now also logs it once).
describe('index.ts gives the codex rollout checks the session’s pty process', () => {
  it('wires the rollout watcher', () => {
    const deps = block(index, 'new CodexRolloutWatcher({', 'codexRolloutRef = codexRollout')
    expect(deps).toMatch(/rolloutOwner: \{\s*pidOf: \(sessionId\) => core\?\.sessions\.pidOf\(sessionId\) \?\? null,\s*read: rolloutOwnerReader\(process\.platform\)\s*\}/)
  })

  it('wires the codex rolling coordinator', () => {
    const deps = block(index, 'new CodexRollingCoordinator({', 'codexRollingRef = codexRolling')
    expect(deps).toMatch(/rolloutOwner: \{\s*pidOf: \(sid\) => core\?\.sessions\.pidOf\(sid\) \?\? null,\s*read: rolloutOwnerReader\(process\.platform\)\s*\}/)
  })
})

// Task D review Minor 7: an ended codex worker's limit is read from the rollout its note names, not the newest file in
// its folder, which can be a sibling worker's
describe('ipc.ts gives the limit probe the rollout the worker’s note names', () => {
  it('reads it from the Host’s pty list', () => {
    const deps = block(ipc, 'probeLimit: makeLimitProbe({', 'log: orchLog')
    expect(deps).toMatch(/rolloutPathOf: async \(sessionId\) => \{\s*const entries = await hostPtyList\?\.\(\)\s*return entries \? noteRolloutPath\(entries, sessionId\) : null/)
  })
})
