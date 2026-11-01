import { describe, it, expect } from 'vitest'
import type { ComparisonRow } from '../../../core/controlPlane/compare'
import type { ReportExtension } from '../../../core/controlPlane/report'
import {
  addressLabel,
  clientSeenLine,
  controlFailureLine,
  expectFailureLine,
  failureLine,
  pairedStateLine,
  pairingLeftLine,
  pairingState,
  pingLine,
  revokeDoneLine,
  stateWord,
  thisMachineLine,
  versionLine
} from './remoteRuntimesText'
import { localTime } from './findingsText'

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

// Remote governance design §4.3, §6.2, §7.3, §10.1: the detail's version line and state words, and This computer's line
// for each paired controller
describe('the Runtime detail text', () => {
  const facts = { asteraVersion: '1.4.8', platform: 'darwin', hostProtocol: 4, capabilities: [], readAt: '2026-10-08T01:02:03.000Z' }
  it('versionLine says both versions and to update when older, both versions alone when newer, nothing with no facts', () => {
    expect(versionLine({ facts, here: '1.5.0', older: true }, t)).toBe(
      'settings.remote.detail.versions {"there":"1.4.8","here":"1.5.0"} settings.remote.detail.updateThere'
    )
    expect(versionLine({ facts: { ...facts, asteraVersion: '1.6.0' }, here: '1.5.0', older: false }, t)).toBe('settings.remote.detail.versions {"there":"1.6.0","here":"1.5.0"}')
    expect(versionLine({ facts: null, here: '1.5.0', older: false }, t)).toBeNull()
  })

  it('stateWord names each state and "only there"', () => {
    const ext = (id: string): ReportExtension => ({ id, kind: 'skill', name: id, enabled: true, providers: ['claude'] })
    const row = (state: ComparisonRow['state'], here: boolean, there: boolean): ComparisonRow => ({
      id: 'x', kind: 'skill', name: 'x', expected: state !== null, here: here ? ext('x') : null, there: there ? ext('x') : null, state
    })
    expect(stateWord(row('missing', true, false), t)).toBe('settings.remote.detail.state.missing')
    expect(stateWord(row('different', true, true), t)).toBe('settings.remote.detail.state.different')
    expect(stateWord(row('off', true, true), t)).toBe('settings.remote.detail.state.off')
    expect(stateWord(row('secret-missing', true, true), t)).toBe('settings.remote.detail.state.secretMissing')
    expect(stateWord(row('same', true, true), t)).toBe('settings.remote.detail.state.same')
    expect(stateWord(row(null, false, true), t)).toBe('settings.remote.detail.state.onlyThere')
    // Not expected: nothing is judged, so nothing is said
    expect(stateWord(row(null, true, false), t)).toBe('')
  })

  it('clientSeenLine names the surface, the version and last seen, and never seen', () => {
    const at = '2026-10-30T09:00:00.000Z'
    expect(clientSeenLine({ surface: 'desktop', clientVersion: '1.5.0', lastSeenAt: at }, t)).toBe(
      `settings.remote.thisMachine.clientSeen {"surface":"settings.remote.surface.desktop","version":"1.5.0","at":${JSON.stringify(localTime(at))}}`
    )
    expect(clientSeenLine({ surface: 'cli', clientVersion: '1.5.0', lastSeenAt: at }, t)).toContain('"surface":"settings.remote.surface.cli"')
    expect(clientSeenLine({ surface: 'mcp', clientVersion: '1.5.0', lastSeenAt: at }, t)).toContain('"surface":"settings.remote.surface.mcp"')
    expect(clientSeenLine({ lastSeenAt: null }, t)).toBe('settings.remote.paired.neverSeen')
    // An older Host, or a controller that has not said what it is yet: when it was last seen, and nothing guessed
    expect(clientSeenLine({ lastSeenAt: at }, t)).toBe(`settings.remote.paired.lastSeen {"at":${JSON.stringify(localTime(at))}}`)
    // Ruling R2-1: a surface this build does not know is shown as its word
    expect(clientSeenLine({ surface: 'tablet' as never, clientVersion: '1.6.0', lastSeenAt: at }, t)).toContain('"surface":"tablet"')
  })

  // Ruling R16-1: the screen's own sentence for an id that is no longer here, never the CLI's that names `astera ext list`
  it('expectFailureLine says an extension is gone in the app language, and any other refusal with its code', () => {
    expect(expectFailureLine({ ok: false, code: 'INVALID_ARGUMENTS', message: 'x is not an extension on this computer; `astera ext list` names them' }, t)).toBe(
      'settings.remote.detail.expectGone'
    )
    expect(expectFailureLine({ ok: false, code: 'RUNTIME_NOT_FOUND', message: 'no paired Runtime has the id rt' }, t)).toBe(
      'settings.remote.failed {"code":"RUNTIME_NOT_FOUND","message":"no paired Runtime has the id rt"}'
    )
  })
})
