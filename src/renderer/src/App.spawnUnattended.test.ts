import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App.tsx's `spawn` is a closure inside the component and cannot run without a full React +
// Electron harness — the same reason main/ipc.ts's spawnSession is guarded by its text rather than
// called directly (see chatAdopt.test.ts). This pins the one line that carries the New Session
// dialog's chat takeover P8 pick (NewSessionDialog.tsx's `unattended` state, arriving here as
// `opts.unattendedPermission`) into the `window.api.sessions.spawn` call. Mutation: dropping the
// field from that call object leaves a chat session spawned from the dialog silently defaulting to
// 'hold' in main/ipc.ts, regardless of what was picked (fix round, chat takeover Task 10).
const APP_TSX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx')
const src = readFileSync(APP_TSX, 'utf8')
const start = src.indexOf('const spawn = async (opts:')
const signatureEnd = src.indexOf('}): Promise<void> => {', start)
const call = src.indexOf('window.api.sessions.spawn({', start)
const callEnd = src.indexOf('})', call)

describe("App.tsx's spawn() forwards the dialog's unattended pick to sessions.spawn (chat takeover Task 10 fix)", () => {
  it('finds spawn(), its opts type and its call to sessions.spawn', () => {
    expect(start).toBeGreaterThan(-1)
    expect(signatureEnd).toBeGreaterThan(start)
    expect(call).toBeGreaterThan(signatureEnd)
    expect(callEnd).toBeGreaterThan(call)
  })

  it("spawn()'s opts accept the policy, and its call to sessions.spawn carries it through unchanged", () => {
    expect(src.slice(start, signatureEnd)).toMatch(/unattendedPermission\?: UnattendedPermission/)
    expect(src.slice(call, callEnd)).toMatch(/unattendedPermission: opts\.unattendedPermission/)
  })
})
