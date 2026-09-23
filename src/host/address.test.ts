import { describe, it, expect } from 'vitest'
import { hostAddress, retireOlderHosts, siblingHostAddresses } from './address'

const PROFILE = 'C:/Users/someone/AppData/Roaming/astera'

describe('hostAddress', () => {
  it('is a named pipe on win32, with nothing to prepare', () => {
    const a = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 })
    expect(a.address).toMatch(/^\\\\\.\\pipe\\astera-host-[0-9a-f]{12}$/)
    expect(a.dirToPrepare).toBeNull()
  })

  it('is a socket inside its own directory on posix, and the directory is what gets locked down', () => {
    const a = hostAddress({ profileDir: '/home/someone/.config/astera', platform: 'linux', tmpDir: '/tmp', protocol: 1 })
    expect(a.dirToPrepare).toMatch(/^\/tmp\/astera-host-[0-9a-f]{12}$/)
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
    // v1 has no suffix of its own — see hostAddress's comment — so matching on the real address it
    // produces is what makes this probe a stand-in for a genuine v1 Host, not a string that nothing
    // has ever listened on.
    const v1 = hostAddress({ profileDir: PROFILE, platform: 'win32', tmpDir: 'C:/Temp', protocol: 1 }).address
    const n = await retireOlderHosts({
      profileDir: PROFILE,
      platform: 'win32',
      tmpDir: 'C:/Temp',
      protocol: 3,
      connect: async (address, line) => {
        // only v1 is there
        if (address !== v1) return false
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

// 감사 #12. 주소에 프로토콜이 들어가서, 판이 다른 CLI 는 살아 있는 Host 를 "없다" 로 보고 그 Host 가
// 쓰는 중인 파일을 읽었다. 같은 프로필의 다른 판 주소를 목록에서 찾는 것이 그 확인의 앞 절반이다.
describe('siblingHostAddresses', () => {
  const own = (protocol: number, platform: NodeJS.Platform = 'win32'): string =>
    hostAddress({ profileDir: PROFILE, platform, tmpDir: '/tmp', protocol }).address
  const nameOf = (address: string): string => address.split(/[\\/]/).filter((p) => p !== 'sock').pop()!

  it('같은 프로필의 다른 판 이름만 고르고, 자기 판은 빼며, 판 번호를 읽는다', () => {
    const names = [
      nameOf(own(1)),
      nameOf(own(3)),
      nameOf(own(7)),
      `${nameOf(own(1))}x`,
      'astera-host-000000000000-v3',
      'unrelated-pipe'
    ]
    const found = siblingHostAddresses({ profileDir: PROFILE, platform: 'win32', tmpDir: '/tmp', protocol: 3, list: () => names })
    expect(found).toEqual([
      { protocol: 1, address: own(1) },
      { protocol: 7, address: own(7) }
    ])
  })

  it('win32 는 파이프 목록을, posix 는 임시 폴더를 읽고 그 안의 sock 을 가리킨다', () => {
    const asked: string[] = []
    const list = (dir: string): string[] => {
      asked.push(dir)
      return [nameOf(own(2, 'linux'))]
    }
    expect(siblingHostAddresses({ profileDir: PROFILE, platform: 'linux', tmpDir: '/tmp/', protocol: 3, list })).toEqual([
      { protocol: 2, address: own(2, 'linux') }
    ])
    siblingHostAddresses({ profileDir: PROFILE, platform: 'win32', tmpDir: '/tmp', protocol: 3, list })
    expect(asked).toEqual(['/tmp', '\\\\.\\pipe\\'])
  })

  it('목록을 못 읽으면 아무것도 없다', () => {
    const list = (): string[] => {
      throw new Error('EACCES')
    }
    expect(siblingHostAddresses({ profileDir: PROFILE, platform: 'win32', tmpDir: '/tmp', protocol: 3, list })).toEqual([])
  })
})
