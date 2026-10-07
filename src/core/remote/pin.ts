// The controller's side of the pin (remote runtime design §4.3; ruling M3 in the Phase 2 plan). Node does not run
// `checkServerIdentity` once the chain has failed to verify, which a self-signed certificate always does, and with
// `rejectUnauthorized: false` its error would not close the socket anyway. So the pin is compared here, on
// `secureConnect`, and the socket reaches the caller only after it matched: nothing can be written before.
import tls, { type TLSSocket } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { spkiSha256 } from './cert'

export function connectPinned(o: { host: string; port: number; pin: string; servername?: string }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: o.host, port: o.port, servername: o.servername, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    const fail = (e: Error): void => {
      sock.destroy()
      reject(e)
    }
    sock.once('error', fail)
    sock.once('secureConnect', () => {
      const raw = sock.getPeerCertificate(false)?.raw
      let got: string | null = null
      try {
        got = raw ? spkiSha256(new X509Certificate(raw).publicKey) : null
      } catch {
        got = null
      }
      if (got !== o.pin) {
        fail(Object.assign(new Error('the Runtime presented a different identity than the one paired'), { code: 'RUNTIME_IDENTITY_CHANGED' }))
        return
      }
      sock.off('error', fail)
      resolve(sock)
    })
  })
}
