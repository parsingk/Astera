import { describe, it, expect } from 'vitest'
import { hostAddress } from './address'

const PROFILE = 'C:/Users/someone/AppData/Roaming/astera'

describe('hostAddress', () => {
  it('is a named pipe on win32, with nothing to prepare', () => {
    const a = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp' })
    expect(a.address).toMatch(/^\\\\\.\\pipe\\astera-host-[0-9a-f]{12}$/)
    expect(a.dirToPrepare).toBeNull()
  })

  it('is a socket inside its own directory on posix, and the directory is what gets locked down', () => {
    const a = hostAddress({ profileDir: '/home/someone/.config/astera', platform: 'linux', tmpDir: '/tmp' })
    expect(a.dirToPrepare).toMatch(/^\/tmp\/astera-host-[0-9a-f]{12}$/)
    expect(a.address).toBe(`${a.dirToPrepare}/sock`)
  })

  it('gives two profiles two addresses, and one profile the same address every time', () => {
    const one = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp' })
    const again = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp' })
    const other = hostAddress({ profileDir: PROFILE + '-dev', platform: 'win32', tmpDir: 'C:/Temp' })
    expect(one.address).toBe(again.address)
    expect(one.address).not.toBe(other.address)
  })

  // A unix socket path is capped at about 104 bytes. macOS puts the temp directory somewhere long,
  // which is exactly why the socket does not live in the profile directory.
  it('stays well inside the posix socket path limit for a real macOS temp directory', () => {
    const a = hostAddress({
      profileDir: '/Users/someone/Library/Application Support/astera',
      platform: 'darwin',
      tmpDir: '/var/folders/qk/8hb0l7t95kn4v1r_9rvvxc4h0000gn/T'
    })
    expect(Buffer.byteLength(a.address)).toBeLessThan(100)
  })
})
