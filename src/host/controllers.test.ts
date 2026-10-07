import { describe, it, expect } from 'vitest'
import { createControllerRegistry, sha256Base64url } from './controllers'

const clock = () => {
  let t = Date.parse('2026-10-07T00:00:00Z')
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('ControllerRegistry (remote runtime design §3.3, §4.4, §4.5)', () => {
  it('a right code works exactly once and yields a token whose hash authenticates', () => {
    const c = clock()
    const r = createControllerRegistry({ now: c.now })
    const { code } = r.createPairing({ permission: 'read-only', name: 'laptop' })
    expect(code).toMatch(/^[A-Z2-7]{10}$/)
    const got = r.redeem(code, 'laptop')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(r.authenticate(sha256Base64url(got.token))?.permission).toBe('read-only')
    expect(r.redeem(code, 'laptop')).toEqual({ ok: false, reason: 'unknown' })
  })
  it('burns a code after five wrong guesses, so the sixth guess fails even when right', () => {
    const r = createControllerRegistry()
    const { code } = r.createPairing({ permission: 'full-control' })
    const wrong = code.slice(0, 9) + (code[9] === 'A' ? 'B' : 'A')
    for (let i = 0; i < 5; i++) expect(r.redeem(wrong, 'x').ok).toBe(false)
    expect(r.redeem(code, 'x')).toEqual({ ok: false, reason: 'burned' })
  })
  it('refuses a right code after ten minutes', () => {
    const c = clock()
    const r = createControllerRegistry({ now: c.now })
    const { code } = r.createPairing({ permission: 'full-control' })
    c.advance(10 * 60 * 1000 + 1)
    expect(r.redeem(code, 'x')).toEqual({ ok: false, reason: 'expired' })
  })
  it('binds a link connection to a client and answers its principal from the record, not from the link', () => {
    const r = createControllerRegistry()
    const got = r.redeem(r.createPairing({ permission: 'read-only', name: 'laptop' }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c1', got.clientId)
    expect(r.principalFor(1, 'c1')).toEqual({ clientId: got.clientId, name: 'laptop', permission: 'read-only' })
    expect(r.principalFor(2, 'c1')).toBeNull()
  })
  it('revocation drops every binding at once, so a queued frame is admitted nowhere and its reply has nowhere to go', () => {
    const r = createControllerRegistry()
    const got = r.redeem(r.createPairing({ permission: 'full-control' }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c1', got.clientId)
    r.bind(1, 'c2', got.clientId)
    const out = r.revoke(got.clientId)
    expect(out).toEqual({ revoked: true, conns: [{ linkGen: 1, conn: 'c1' }, { linkGen: 1, conn: 'c2' }] })
    expect(r.principalFor(1, 'c1')).toBeNull()
    expect(r.stillBound(1, 'c1', got.clientId)).toBe(false)
    expect(r.authenticate(sha256Base64url(got.token))).toBeNull()
  })
  it('lists clients without their token hash, and forgets a link generation whole', () => {
    const r = createControllerRegistry()
    const got = r.redeem(r.createPairing({ permission: 'full-control', name: 'desk' }).code, 'desk')
    if (!got.ok) throw new Error('redeem')
    expect(r.list()[0]).not.toHaveProperty('tokenHash')
    r.bind(3, 'c1', got.clientId)
    r.dropLink(3)
    expect(r.principalFor(3, 'c1')).toBeNull()
  })
})
