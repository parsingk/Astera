import { describe, it, expect } from 'vitest'
import { reachableUrls } from './httpUrls'

describe('reachableUrls', () => {
  it('names private IPv4 addresses lan and the Tailscale range tailscale', () => {
    expect(reachableUrls(['10.0.0.2', '172.16.4.1', '172.31.255.1', '192.168.1.5', '100.64.0.1', '100.127.255.254'], 7871, [])).toEqual([
      { url: 'http://10.0.0.2:7871/mcp', kind: 'lan' },
      { url: 'http://172.16.4.1:7871/mcp', kind: 'lan' },
      { url: 'http://172.31.255.1:7871/mcp', kind: 'lan' },
      { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' },
      { url: 'http://100.64.0.1:7871/mcp', kind: 'tailscale' },
      { url: 'http://100.127.255.254:7871/mcp', kind: 'tailscale' }
    ])
  })

  it('leaves out loopback, link-local, public addresses and the edges of the private ranges', () => {
    const out = ['127.0.0.1', '127.5.0.1', 'localhost', '::1', '169.254.3.4', 'fe80::2', 'febf::1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2001:db8::1', 'fc00::1', '192.169.0.1']
    expect(reachableUrls(out, 7871, [])).toEqual([])
  })

  it('keeps an IPv6 ULA (fd00::/8) as lan, bracketed', () => {
    expect(reachableUrls(['fd7a:115c:a1e0::1', 'fd::1'], 7871, [])).toEqual([{ url: 'http://[fd7a:115c:a1e0::1]:7871/mcp', kind: 'lan' }])
  })

  it('orders lan, tailscale, name, each in the order given, without repeats', () => {
    expect(reachableUrls(['box.ts.net', '100.100.1.1', '192.168.1.5', 'pc', '10.0.0.2', '192.168.1.5'], 7871, ['box.ts.net', 'pc'])).toEqual([
      { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' },
      { url: 'http://10.0.0.2:7871/mcp', kind: 'lan' },
      { url: 'http://100.100.1.1:7871/mcp', kind: 'tailscale' },
      { url: 'http://box.ts.net:7871/mcp', kind: 'name' },
      { url: 'http://pc:7871/mcp', kind: 'name' }
    ])
  })

  it('names a typed host name, keeps a port only when one was typed, and leaves out a typed localhost', () => {
    expect(reachableUrls(['box.tail.net', 'proxy:9000', 'localhost'], 7871, ['Box.Tail.Net', 'proxy:9000', 'localhost'])).toEqual([
      { url: 'http://box.tail.net:7871/mcp', kind: 'name' },
      { url: 'http://proxy:9000/mcp', kind: 'name' }
    ])
  })

  it('classifies a typed IP literal by its range, not as a name', () => {
    expect(reachableUrls(['100.90.1.2', '8.8.4.4', '192.168.0.9:9000'], 7871, ['100.90.1.2', '8.8.4.4', '192.168.0.9:9000'])).toEqual([
      { url: 'http://192.168.0.9:9000/mcp', kind: 'lan' },
      { url: 'http://100.90.1.2:7871/mcp', kind: 'tailscale' }
    ])
  })

  it('leaves out a name nobody typed', () => {
    expect(reachableUrls(['stranger'], 7871, ['box'])).toEqual([])
  })
})
