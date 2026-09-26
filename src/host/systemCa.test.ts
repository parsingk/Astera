import { describe, it, expect } from 'vitest'
import tls from 'node:tls'
import { trustSystemCa } from './systemCa'

// S6-22, the CA half: behind a TLS-inspecting proxy the usage lookup's HTTPS only verifies against
// the proxy's root, which the OS store holds and Node's bundled list does not.
const fakeTls = (d: { def: string[]; system: string[]; setThrows?: Error; getThrows?: Error }) => {
  const set: string[][] = []
  return {
    set,
    tls: {
      getCACertificates: (type?: 'default' | 'system' | 'bundled' | 'extra'): string[] => {
        if (d.getThrows) throw d.getThrows
        return type === 'system' ? d.system : d.def
      },
      setDefaultCACertificates: (certs: ReadonlyArray<string>): void => {
        if (d.setThrows) throw d.setThrows
        set.push([...certs])
      }
    }
  }
}

describe('trustSystemCa', () => {
  it('adds the OS store to the default CAs, once each, keeping the defaults first', () => {
    const f = fakeTls({ def: ['A', 'B'], system: ['B', 'C', 'D'] })
    const logs: string[] = []
    expect(trustSystemCa(f.tls, (m) => logs.push(m), () => true)).toBe('added')
    expect(f.set).toEqual([['A', 'B', 'C', 'D']])
    expect(logs.join('\n')).toMatch(/2 certificates/)
  })

  it('changes nothing when the OS store adds nothing new', () => {
    const f = fakeTls({ def: ['A', 'B'], system: ['A'] })
    expect(trustSystemCa(f.tls, () => {}, () => true)).toBe('nothing-new')
    expect(f.set).toEqual([])
  })

  it('keeps the defaults and logs when reading the OS store fails', () => {
    const f = fakeTls({ def: ['A'], system: [], getThrows: new Error('store locked') })
    const logs: string[] = []
    expect(trustSystemCa(f.tls, (m) => logs.push(m), () => true)).toBe('failed')
    expect(f.set).toEqual([])
    expect(logs.join('\n')).toMatch(/store locked/)
  })

  it('keeps the defaults and logs when setting them fails', () => {
    const f = fakeTls({ def: ['A'], system: ['B'], setThrows: new Error('bad pem') })
    const logs: string[] = []
    expect(trustSystemCa(f.tls, (m) => logs.push(m), () => true)).toBe('failed')
    expect(logs.join('\n')).toMatch(/bad pem/)
  })

  // Final review M4: one malformed certificate in the OS store must not cost the proxy's root.
  it('skips a certificate the probe finds invalid and adds the rest', () => {
    const f = fakeTls({ def: ['A'], system: ['B', 'BAD', 'C'] })
    const logs: string[] = []
    expect(trustSystemCa(f.tls, (m) => logs.push(m), (c) => c !== 'BAD')).toBe('added')
    expect(f.set).toEqual([['A', 'B', 'C']])
    expect(logs.join('\n')).toMatch(/skipped 1/)
  })

  it('probes with X509Certificate by default: a real root is added and junk is not', () => {
    const root = tls.rootCertificates[0]
    const f = fakeTls({ def: [], system: [root, 'not a certificate'] })
    expect(trustSystemCa(f.tls, () => {})).toBe('added')
    expect(f.set).toEqual([[root]])
  })

  it('adds one at a time when the whole set is refused, keeping every certificate that is accepted', () => {
    const set: string[][] = []
    const seam = {
      getCACertificates: (type?: 'default' | 'system' | 'bundled' | 'extra'): string[] => (type === 'system' ? ['B', 'X', 'C'] : ['A']),
      setDefaultCACertificates: (certs: ReadonlyArray<string>): void => {
        if (certs.includes('X')) throw new Error('bad pem')
        set.push([...certs])
      }
    }
    const logs: string[] = []
    expect(trustSystemCa(seam, (m) => logs.push(m), () => true)).toBe('added')
    expect(set[set.length - 1]).toEqual(['A', 'B', 'C'])
    expect(logs.join('\n')).toMatch(/skipped 1/)
  })

  it('does nothing on a Node without the API, and says so', () => {
    const logs: string[] = []
    expect(trustSystemCa({}, (m) => logs.push(m))).toBe('unsupported')
    expect(logs).toHaveLength(1)
  })

  // The real module fits the seam; the Host passes `node:tls` itself.
  it('accepts node:tls as its seam', () => {
    const seam: Parameters<typeof trustSystemCa>[0] = tls
    expect(seam).toBe(tls)
  })
})
