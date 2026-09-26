// S6-22, the CA half: the Host's HTTPS (the usage lookup, RateLimitFetcher on Node's global fetch)
// verifies against Node's bundled roots only. Behind a TLS-inspecting proxy the certificate it is
// shown is signed by the proxy's own root, which the company put in the OS store and not in Node's
// list, so every lookup failed. This adds the OS store to the default CAs once, at Host start, with the
// Node 24 API (`tls.getCACertificates('system')` and `tls.setDefaultCACertificates`). It changes only
// connections made afterwards that pass no `ca` of their own.
//
// The system proxy itself (a lookup that must go through an HTTP proxy) stays a known limit: Node's
// fetch does not read it, and this does not try to.
import { X509Certificate } from 'node:crypto'

/** The part of `node:tls` this needs. Both optional: `setDefaultCACertificates` came in Node 22.19 and
 *  24.5 (`getCACertificates` in 22.15 and 23.10), and a Node without both is left alone. */
export interface TlsCaSeam {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: ReadonlyArray<string>) => void
}

export type SystemCaOutcome = 'added' | 'nothing-new' | 'unsupported' | 'failed'

/** Whether `pem` parses as a certificate: the default probe `trustSystemCa` judges each one with. */
export function parsesAsCertificate(pem: string): boolean {
  try {
    new X509Certificate(pem)
    return true
  } catch {
    return false
  }
}

/** Adds the OS certificate store to the default CAs, keeping the current defaults first and each
 *  certificate once. Never throws: on any error it logs and the defaults stay as they were.
 *
 *  **Judged one certificate at a time** (final review M4). `setDefaultCACertificates` applies nothing
 *  when any one certificate is bad, so one malformed entry in the OS store would cost the proxy's root
 *  with it. Each is probed first (`probe`, by default `parsesAsCertificate`) and a bad one is skipped;
 *  and should the whole set still be refused, they are added one at a time, each kept only if the set
 *  with it is accepted. */
export function trustSystemCa(tls: TlsCaSeam, log: (m: string) => void, probe: (pem: string) => boolean = parsesAsCertificate): SystemCaOutcome {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    log('system CA: this Node cannot read the OS certificate store; the bundled roots stay the only ones')
    return 'unsupported'
  }
  try {
    const current = tls.getCACertificates('default')
    const system = tls.getCACertificates('system')
    const seen = new Set(current)
    const fresh = system.filter((c) => !seen.has(c) && (seen.add(c), true))
    if (fresh.length === 0) return 'nothing-new'
    const valid = fresh.filter((c) => probe(c))
    let added = valid
    try {
      if (valid.length > 0) tls.setDefaultCACertificates([...current, ...valid])
    } catch (err) {
      log(`system CA: the OS store's certificates were refused together (${String(err)}); adding them one at a time`)
      added = []
      for (const c of valid) {
        try {
          tls.setDefaultCACertificates([...current, ...added, c])
          added.push(c)
        } catch {
          /* this one is refused: skipped, and the set stays what it was before it */
        }
      }
    }
    const skipped = fresh.length - added.length
    if (added.length === 0) {
      log(`system CA: no certificate from the OS store could be added (skipped ${skipped}), the defaults stay`)
      return 'failed'
    }
    log(`system CA: added ${added.length} certificates from the OS store to the default CAs${skipped > 0 ? `, skipped ${skipped} that were not valid` : ''}`)
    return 'added'
  } catch (err) {
    log(`system CA: could not add the OS certificate store, the defaults stay: ${String(err)}`)
    return 'failed'
  }
}
