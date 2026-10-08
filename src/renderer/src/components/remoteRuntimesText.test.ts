import { describe, it, expect } from 'vitest'
import { failureLine, pairedStateLine, pingLine, thisMachineLine } from './remoteRuntimesText'

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
