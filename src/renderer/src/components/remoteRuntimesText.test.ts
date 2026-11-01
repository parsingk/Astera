import { describe, it, expect } from 'vitest'
import { addressLabel, controlFailureLine, failureLine, pairedStateLine, pairingLeftLine, pairingState, pingLine, revokeDoneLine, thisMachineLine } from './remoteRuntimesText'

/** A t that shows the key and its params, so each assertion names the sentence it expects. */
const t = (key: string, params?: Record<string, unknown>): string => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`

describe('Settings › Remote Runtimes text (remote runtime design Phase 6)', () => {
  it('this computer: unknown, off, or on with its address and Gateway state', () => {
    expect(thisMachineLine(null, t)).toBe('settings.remote.thisMachine.unknown')
    expect(thisMachineLine({ gateway: { state: 'disabled' }, clients: [] }, t)).toBe('settings.remote.thisMachine.off')
    expect(thisMachineLine({ gateway: { state: 'ready', listen: '100.64.0.5', port: 47831 }, clients: [] }, t)).toBe(
      'settings.remote.thisMachine.on {"listen":"100.64.0.5","port":47831,"state":"ready"}'
    )
  })
  it('a ping answers with the version and platform, or the code; never a token', () => {
    expect(pingLine({ ok: true, hello: { runtimeId: 'rt', displayName: 'Office', asteraVersion: '1.4.8', platform: 'linux', bootId: 'b' } }, t)).toBe(
      'settings.remote.paired.online {"version":"1.4.8","platform":"linux"}'
    )
    expect(pingLine({ ok: false, code: 'RUNTIME_OFFLINE', message: 'connect refused' }, t)).toBe('settings.remote.paired.offline {"code":"RUNTIME_OFFLINE"}')
  })
  it('a failure says its code and message', () => {
    expect(failureLine({ ok: false, code: 'RUNTIME_IDENTITY_CHANGED', message: 'a different key' }, t)).toBe(
      'settings.remote.failed {"code":"RUNTIME_IDENTITY_CHANGED","message":"a different key"}'
    )
  })
})

// Phase 6 review minor: the list says a paired Runtime did not answer the last time this app asked it.
describe('a paired Runtime state line', () => {
  it('says it did not answer only when the last call went unanswered', () => {
    expect(pairedStateLine({ offline: true }, t)).toBe('settings.remote.paired.notAnswering')
    expect(pairedStateLine({ offline: false }, t)).toBeNull()
    expect(pairedStateLine({ offline: null }, t)).toBeNull()
  })
})

// Settings › This computer's own controls (turning Remote on, a pairing string): an address is named with where it is,
// and a pairing string says how long it has left, and goes when it has none or Remote went off (review focus 2).
describe("this computer's controls text", () => {
  it('names an address by its interface, and 127.0.0.1 as this computer only', () => {
    expect(addressLabel({ address: '192.168.0.235', iface: 'Wi-Fi', local: false }, t)).toBe('settings.remote.start.iface {"address":"192.168.0.235","iface":"Wi-Fi"}')
    expect(addressLabel({ address: '127.0.0.1', iface: null, local: true }, t)).toBe('settings.remote.start.local {"address":"127.0.0.1"}')
  })

  it("says the time a pairing string has left, as minutes and seconds, and that it is spent once it is not", () => {
    const at = Date.parse('2026-10-12T05:10:00.000Z')
    expect(pairingLeftLine('2026-10-12T05:10:00.000Z', at - 581_000, t)).toBe('settings.remote.newPair.expires {"time":"9:41"}')
    expect(pairingLeftLine('2026-10-12T05:10:00.000Z', at - 5_000, t)).toBe('settings.remote.newPair.expires {"time":"0:05"}')
    expect(pairingLeftLine('2026-10-12T05:10:00.000Z', at, t)).toBe('settings.remote.newPair.expired')
    expect(pairingLeftLine('not a time', at, t)).toBe('settings.remote.newPair.expired')
  })

  // Review of the Settings controls (minor 1, 2): a string is shown while the Host still holds its code; once it expired,
  // was used or was dropped the screen says which instead of showing a string that cannot pair; with Remote off (or the
  // Host unable to say) it goes.
  it('tells a live pairing string from an expired, a spent and a gone one', () => {
    const at = Date.parse('2026-10-12T05:10:00.000Z')
    const made = { expiresAt: '2026-10-12T05:10:00.000Z', pairingId: 'p1' }
    const on = (pairings?: string[]) => ({ gateway: { state: 'ready' }, clients: [], ...(pairings ? { pairings } : {}) })
    expect(pairingState(made, on(['p1']), at - 1_000)).toBe('live')
    expect(pairingState(made, on(), at - 1_000)).toBe('live')
    expect(pairingState(made, on(['p1']), at + 1)).toBe('expired')
    expect(pairingState(made, on([]), at - 1_000)).toBe('spent')
    expect(pairingState(made, { gateway: { state: 'disabled' }, clients: [] }, at - 1_000)).toBe('gone')
    expect(pairingState(made, null, at - 1_000)).toBe('gone')
  })
})

// Review of the Settings controls (minor 3): the CLI's English sentences ("run `astera runtime start` first") are not
// what a person in the app should read; the known refusals are said in the app's language, the rest as before.
describe('a refusal of a control, in the app language', () => {
  it('says the known refusals in the app language, and any other with its code and message', () => {
    expect(controlFailureLine({ ok: false, code: 'INVALID_ARGUMENTS', message: 'listen on one of the addresses this computer offers' }, 'start', t)).toBe('settings.remote.control.badAddress')
    expect(controlFailureLine({ ok: false, code: 'CONFLICT', message: 'Remote Runtime is off' }, 'pair', t)).toBe('settings.remote.control.off')
    expect(controlFailureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: 'x' }, 'stop', t)).toBe('settings.remote.control.noHost')
    expect(controlFailureLine({ ok: false, code: 'TIMEOUT', message: 'x' }, 'start', t)).toBe('settings.remote.control.timeout')
    expect(controlFailureLine({ ok: false, code: 'FAILED', message: 'the Gateway failed: EADDRINUSE: taken' }, 'start', t)).toBe('settings.remote.control.gatewayFailed {"code":"EADDRINUSE"}')
    expect(controlFailureLine({ ok: false, code: 'NOT_FOUND', message: 'unknown client: cli_1' }, 'revoke', t)).toBe('settings.remote.failed {"code":"NOT_FOUND","message":"unknown client: cli_1"}')
  })
})

// Remote governance design §8.2 to §8.4 (ruling R8-1): the revoke toast says what happened to the controller's scheduled
// Jobs, and which could not be paused
describe('the revoke toast', () => {
  it('revokeDoneLine words the counts, and falls back to the old line for an older Host', () => {
    expect(revokeDoneLine({ name: 'laptop', pausedJobs: 2, unrecordedScheduled: 1, notPaused: [] }, t)).toBe(
      'settings.remote.revoke.paused {"name":"laptop","paused":2,"unrecorded":1}'
    )
    expect(revokeDoneLine({ name: 'laptop', pausedJobs: 0, unrecordedScheduled: 0, notPaused: [{ jobId: 'job_a' }, { jobId: 'job_b' }] }, t)).toBe(
      'settings.remote.revoke.paused {"name":"laptop","paused":0,"unrecorded":0} settings.remote.revoke.notPaused {"jobs":"job_a, job_b"}'
    )
    expect(revokeDoneLine({ name: 'laptop' }, t)).toBe('settings.remote.revoke.done {"name":"laptop"}')
    // Ruling R8-3: nothing paused, unrecorded or refused is the plain line
    expect(revokeDoneLine({ name: 'laptop', pausedJobs: 0, unrecordedScheduled: 0, notPaused: [] }, t)).toBe('settings.remote.revoke.done {"name":"laptop"}')
  })
})
