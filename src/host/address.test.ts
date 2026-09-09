import { describe, it, expect } from 'vitest'
import { hostAddress, retireOlderHosts } from './address'

const PROFILE = 'C:/Users/someone/AppData/Roaming/astera'

describe('hostAddress', () => {
  it('is a named pipe on win32, with nothing to prepare', () => {
    const a = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    expect(a.address).toMatch(/^\\\\\.\\pipe\\astera-host-[0-9a-f]{12}-v1$/)
    expect(a.dirToPrepare).toBeNull()
  })

  it('is a socket inside its own directory on posix, and the directory is what gets locked down', () => {
    const a = hostAddress({ profileDir: '/home/someone/.config/astera', platform: 'linux', tmpDir: '/tmp', protocol: 1 })
    expect(a.dirToPrepare).toMatch(/^\/tmp\/astera-host-[0-9a-f]{12}-v1$/)
    expect(a.address).toBe(`${a.dirToPrepare}/sock`)
  })

  it('gives two profiles two addresses, and one profile the same address every time', () => {
    const one = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    const again = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    const other = hostAddress({ profileDir: PROFILE + '-dev', platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    expect(one.address).toBe(again.address)
    expect(one.address).not.toBe(other.address)
  })

  // A unix socket path is capped at about 104 bytes. macOS puts the temp directory somewhere long,
  // which is exactly why the socket does not live in the profile directory.
  it('stays well inside the posix socket path limit for a real macOS temp directory', () => {
    const a = hostAddress({
      profileDir: '/Users/someone/Library/Application Support/astera',
      platform: 'darwin',
      tmpDir: '/var/folders/qk/8hb0l7t95kn4v1r_9rvvxc4h0000gn/T',
      protocol: 1
    })
    expect(Buffer.byteLength(a.address)).toBeLessThan(100)
  })

  // Two protocols are two different Hosts, and they must not find each other: after slice 2 the
  // older one is holding terminals, and an app that cannot speak to it must not adopt it either.
  it('puts the protocol in the address, so two versions never share one', () => {
    const one = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    const two = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 2 })
    expect(one.address).not.toBe(two.address)
    expect(two.address).toMatch(/-v2$/)
  })

  it('still fits a real macOS temp directory with the version on the end', () => {
    const a = hostAddress({
      profileDir: '/Users/someone/Library/Application Support/astera',
      platform: 'darwin',
      tmpDir: '/var/folders/qk/8hb0l7t95kn4v1r_9rvvxc4h0000gn/T',
      protocol: 2
    })
    expect(Buffer.byteLength(a.address)).toBeLessThan(100)
  })
})

describe('retireOlderHosts', () => {
  it("tells every older protocol's Host to leave, and reports how many answered", async () => {
    const spoken: Array<[string, string]> = []
    const n = await retireOlderHosts({
      profileDir: PROFILE,
      platform: 'win32',
      tmpDir: 'C:/Temp',
      protocol: 3,
      connect: async (address, line) => {
        // only v1 is there
        if (!address.endsWith('-v1')) return false
        spoken.push([address, line])
        return true
      },
      log: () => {}
    })
    expect(n).toBe(1)
    expect(spoken[0][1]).toContain('retire')
  })

  it('does nothing at protocol 1, where there is nothing older', async () => {
    let tried = 0
    const n = await retireOlderHosts({
      profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1,
      connect: async () => { tried += 1; return false },
      log: () => {}
    })
    expect([n, tried]).toEqual([0, 0])
  })
})
