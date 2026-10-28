import { describe, expect, it } from 'vitest'
import { credentialStoreDenies, hostSocketDenies, sensitiveLocations } from './locations'

describe('sandbox locations', () => {
  it('lists E6 on every OS, with gh and gcloud where each OS keeps them', () => {
    expect(sensitiveLocations('linux', {}, '/h')).toEqual(['/h/.ssh', '/h/.aws', '/h/.config/gh', '/h/.config/gcloud', '/h/.docker', '/h/.npmrc', '/h/.git-credentials', '/h/.kube'])
    const win = sensitiveLocations('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')
    expect(win).toContain('C:/Users/a/AppData/Roaming/GitHub CLI')
    expect(win).toContain('C:/Users/a/AppData/Roaming/gcloud')
    expect(win).toContain('C:/Users/a/.ssh')
  })

  it('falls back to the default Roaming folder when APPDATA is unset', () => {
    expect(sensitiveLocations('win32', {}, 'C:\\Users\\a')).toContain('C:/Users/a/AppData/Roaming/gcloud')
  })

  it('adds the OS credential store a sandbox does not close by itself', () => {
    expect(credentialStoreDenies('darwin', {}, '/Users/a')).toEqual(['/Users/a/Library/Keychains'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus,guid=x' }, '/h')).toEqual(['/run/user/1000/bus'])
    expect(credentialStoreDenies('linux', { XDG_RUNTIME_DIR: '/run/user/7' }, '/h')).toEqual(['/run/user/7/bus'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/x' }, '/h')).toEqual([])
    expect(credentialStoreDenies('linux', {}, '/h')).toEqual([])
    expect(credentialStoreDenies('win32', {}, 'C:\\Users\\a')).toEqual([])
  })

  // Final fix pass (C2): the folder the Host's socket is in, so a sandboxed Codex session reaches the Host only through
  // the loopback and its workload token; the Host key is kept in the profile folder, not here, so the loopback's proof
  // still reads it. macOS keeps /var and /tmp as links into /private, so both spellings are named. Windows' Host listens
  // on a named pipe, no file
  it('names the folder of the Host’s socket on macOS and Linux, in both macOS spellings', () => {
    expect(hostSocketDenies('linux', '/tmp/astera-host-0123456789ab-v4')).toEqual(['/tmp/astera-host-0123456789ab-v4'])
    expect(hostSocketDenies('darwin', '/var/folders/x/T/astera-host-0123456789ab-v4/')).toEqual([
      '/var/folders/x/T/astera-host-0123456789ab-v4',
      '/private/var/folders/x/T/astera-host-0123456789ab-v4'
    ])
    expect(hostSocketDenies('darwin', '/Users/a/tmp/astera-host-k-v4')).toEqual(['/Users/a/tmp/astera-host-k-v4'])
    expect(hostSocketDenies('win32', null)).toEqual([])
    expect(hostSocketDenies('linux', null)).toEqual([])
  })
})
