// The one string `astera runtime pair` prints and `astera runtimes add --pair` takes (remote runtime design §4.4):
// `astera-pair:v1:<address-hint>:<port>:<code>:<spki-sha256-base64url>`. An IPv6 hint is written in brackets so the
// colons that follow still separate fields. It carries the code, so it is never logged (§4.7).

export interface PairingParts {
  address: string
  port: number
  code: string
  fingerprint: string
}

const PREFIX = 'astera-pair:v1:'
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/

export function formatPairing(p: PairingParts): string {
  const address = p.address.includes(':') ? `[${p.address}]` : p.address
  return `${PREFIX}${address}:${p.port}:${p.code}:${p.fingerprint}`
}

export function parsePairing(input: string): PairingParts | { error: string } {
  const s = input.trim()
  if (!s.startsWith(PREFIX)) return { error: 'not an Astera pairing string (it starts with astera-pair:v1:)' }
  let rest = s.slice(PREFIX.length)
  let address: string
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0 || rest[close + 1] !== ':') return { error: 'the address in the pairing string is not closed' }
    address = rest.slice(1, close)
    rest = rest.slice(close + 2)
  } else {
    const colon = rest.indexOf(':')
    if (colon <= 0) return { error: 'the pairing string has no address' }
    address = rest.slice(0, colon)
    rest = rest.slice(colon + 1)
  }
  const [portText, code, fingerprint, ...extra] = rest.split(':')
  const port = Number(portText)
  if (extra.length > 0 || !code || fingerprint === undefined) return { error: 'the pairing string has the wrong number of parts' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'the port in the pairing string is not 1 to 65535' }
  if (!FINGERPRINT.test(fingerprint)) return { error: 'the fingerprint in the pairing string is not 43 base64url characters' }
  return { address, port, code, fingerprint }
}
