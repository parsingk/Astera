// S6-22, the CA half: the Host's HTTPS (the usage lookup, RateLimitFetcher on Node's global fetch)
// verifies against Node's bundled roots only. Behind a TLS-inspecting proxy the certificate it is
// shown is signed by the proxy's own root, which the company put in the OS store and not in Node's
// list, so every lookup failed. This adds the OS store to the default CAs once, at Host start, with the
// Node 24 API (`tls.getCACertificates('system')` and `tls.setDefaultCACertificates`). It changes only
// connections made afterwards that pass no `ca` of their own.
//
// The system proxy itself (a lookup that must go through an HTTP proxy) stays a known limit: Node's
// fetch does not read it, and this does not try to.

/** The part of `node:tls` this needs. Both optional: a Node before 22.15/23.5 has neither. */
export interface TlsCaSeam {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: ReadonlyArray<string>) => void
}

export type SystemCaOutcome = 'added' | 'nothing-new' | 'unsupported' | 'failed'

/** Adds the OS certificate store to the default CAs, keeping the current defaults first and each
 *  certificate once. Never throws: on any error it logs and the defaults stay as they were. */
export function trustSystemCa(tls: TlsCaSeam, log: (m: string) => void): SystemCaOutcome {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    log('system CA: this Node cannot read the OS certificate store; the bundled roots stay the only ones')
    return 'unsupported'
  }
  try {
    const current = tls.getCACertificates('default')
    const system = tls.getCACertificates('system')
    const seen = new Set(current)
    const added = system.filter((c) => !seen.has(c) && (seen.add(c), true))
    if (added.length === 0) return 'nothing-new'
    tls.setDefaultCACertificates([...current, ...added])
    log(`system CA: added ${added.length} certificates from the OS store to the default CAs`)
    return 'added'
  } catch (err) {
    log(`system CA: could not add the OS certificate store, the defaults stay: ${String(err)}`)
    return 'failed'
  }
}
