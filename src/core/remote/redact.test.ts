import { describe, it, expect } from 'vitest'
import { redactSecrets } from './redact'

const TOKEN = 'q5c2X0p9-wVz8JkR7aLmN1oPqRsTuVwXyZ0123456_A'

describe('redactSecrets (remote runtime design §4.7)', () => {
  it('removes token, tokenHash and code values in JSON', () => {
    const out = redactSecrets(`{"t":"auth","token":"${TOKEN}","client":{"name":"x"}}`)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('[redacted]')
    expect(redactSecrets('{"conn":"c1","tokenHash":"abc"}')).not.toContain('abc')
    expect(redactSecrets('{"t":"redeem","code":"ABCDE23456"}')).not.toContain('ABCDE23456')
  })
  it('removes --token and --code arguments, a pairing string, and a token-looking run after the word token', () => {
    expect(redactSecrets('ran with --token abc123 and --code=XYZ')).not.toMatch(/abc123|XYZ/)
    expect(redactSecrets('pair: astera-pair:v1:10.0.0.2:47831:ABCDE23456:' + 'f'.repeat(43))).not.toContain('ABCDE23456')
    expect(redactSecrets(`bad token ${TOKEN} refused`)).not.toContain(TOKEN)
  })
  it('leaves an ordinary line alone', () => {
    const line = 'gateway: listening on 127.0.0.1:47831 (3 clients)'
    expect(redactSecrets(line)).toBe(line)
  })

  // Phase 3 minor: Node's inspect form (an Error or an object printed to stderr) quotes values with ' and leaves keys bare.
  it("redacts the inspect form: { token: '...', code: '...' }", () => {
    const out = redactSecrets("Error: x { token: 'abcdef', tokenHash: 'h1', code: 'ABCDEFGHJK', other: 'keep' }")
    expect(out).not.toContain('abcdef')
    expect(out).not.toContain("'h1'")
    expect(out).not.toContain('ABCDEFGHJK')
    expect(out).toContain("other: 'keep'")
  })
})
