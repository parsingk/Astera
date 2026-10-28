import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appKeyDenies, credentialStoreDenies, hostSocketDenies, otherHostFolders, profileReadOnly, sensitiveLocations } from './locations'

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

  // Sandbox follow-ups, item 1: the app's key lets a process be the app to the Host, so it is named on every OS; the Host
  // key beside it is not (the loopback's proof needs it)
  it('names the app key on every OS, with forward slashes, and nothing without one', () => {
    expect(appKeyDenies('C:\\Users\\a\\AppData\\Roaming\\astera\\host\\app.key')).toEqual(['C:/Users/a/AppData/Roaming/astera/host/app.key'])
    expect(appKeyDenies('/home/a/.config/astera/host/app.key')).toEqual(['/home/a/.config/astera/host/app.key'])
    expect(appKeyDenies(null)).toEqual([])
  })

  // Task E (2026-10-28): what the app and the Host run outside any sandbox is in the profile folder, so a sandboxed session
  // may not write it, on every OS; named whole, with forward slashes
  it('names the profile folder read-only on every OS, with forward slashes, and nothing without one', () => {
    expect(profileReadOnly('C:\\Users\\a\\AppData\\Roaming\\astera')).toEqual(['C:/Users/a/AppData/Roaming/astera'])
    expect(profileReadOnly('/home/a/.config/astera/')).toEqual(['/home/a/.config/astera'])
    expect(profileReadOnly(null)).toEqual([])
  })

  it('adds the OS credential store a sandbox does not close by itself', () => {
    expect(credentialStoreDenies('darwin', {}, '/Users/a')).toEqual(['/Users/a/Library/Keychains'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus,guid=x' }, '/h')).toEqual(['/run/user/1000/bus'])
    expect(credentialStoreDenies('linux', { XDG_RUNTIME_DIR: '/run/user/7' }, '/h')).toEqual(['/run/user/7/bus'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/x' }, '/h')).toEqual([])
    expect(credentialStoreDenies('linux', {}, '/h')).toEqual([])
    // Final fix pass (minor 8): a D-Bus address escapes bytes in a value as %xx, so the path is decoded before it is denied
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/my%20bus,guid=x' }, '/h')).toEqual(['/run/user/1000/my bus'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/%ED%95%9C/bus' }, '/h')).toEqual(['/tmp/한/bus'])
    expect(credentialStoreDenies('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/100%25' }, '/h')).toEqual(['/tmp/100%'])
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
  // Final fix pass, part 2 (B): the other Hosts' folders found beside this one are named too, each in both macOS
  // spellings, once each
  it('names every other Host folder it is given beside this one', () => {
    expect(hostSocketDenies('linux', '/tmp/astera-host-aaaaaaaaaaaa-v4', ['/tmp/astera-host-bbbbbbbbbbbb-v4', '/tmp/astera-host-aaaaaaaaaaaa-v4'])).toEqual([
      '/tmp/astera-host-aaaaaaaaaaaa-v4',
      '/tmp/astera-host-bbbbbbbbbbbb-v4'
    ])
    expect(hostSocketDenies('darwin', '/var/folders/x/T/astera-host-a-v4', ['/var/folders/x/T/astera-host-b-v4'])).toEqual([
      '/var/folders/x/T/astera-host-a-v4',
      '/private/var/folders/x/T/astera-host-a-v4',
      '/var/folders/x/T/astera-host-b-v4',
      '/private/var/folders/x/T/astera-host-b-v4'
    ])
    expect(hostSocketDenies('win32', null, [])).toEqual([])
  })
})

// Final fix pass, part 2 (B): every Host's socket folder in the folder this profile's is in, another profile's Host such
// as the dev app's beside the installed app's, read once when a sandboxed Codex session starts
describe('the other Hosts beside this one', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const slashed = (p: string): string => p.replace(/\\/g, '/')

  it('lists every other astera-host- folder there, and no other folder', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'astera-hosts-'))
    dirs.push(parent)
    const own = path.join(parent, 'astera-host-aaaaaaaaaaaa-v4')
    const dev = path.join(parent, 'astera-host-bbbbbbbbbbbb-v4')
    for (const d of [own, dev, path.join(parent, 'unrelated')]) mkdirSync(d)
    expect(await otherHostFolders('linux', own)).toEqual([slashed(dev)])
    expect(await otherHostFolders('darwin', `${slashed(own)}/`)).toEqual([slashed(dev)])
    // No folder on Windows (the Host listens on a named pipe), nor without this Host's own
    expect(await otherHostFolders('win32', own)).toEqual([])
    expect(await otherHostFolders('linux', null)).toEqual([])
    // A folder that cannot be listed names none
    expect(await otherHostFolders('linux', path.join(parent, 'gone', 'astera-host-cccccccccccc-v4'))).toEqual([])
  })

  // Final fix pass, part 3: only this user's Hosts. Linux's /tmp is everyone's: another user's Host folder (mode 0700,
  // closed to this user anyway) is neither named nor lets anyone lengthen the command line. A folder that cannot be
  // looked at (gone since the listing) is left out
  it("lists only the folders this user owns, by each folder's own owner", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'astera-hosts-'))
    dirs.push(parent)
    const own = path.join(parent, 'astera-host-aaaaaaaaaaaa-v4')
    const names = { mine: 'astera-host-bbbbbbbbbbbb-v4', theirs: 'astera-host-cccccccccccc-v4', gone: 'astera-host-dddddddddddd-v4', root: 'astera-host-eeeeeeeeeeee' }
    for (const d of [own, ...Object.values(names).map((n) => path.join(parent, n)), path.join(parent, 'unrelated')]) mkdirSync(d)
    const owners: Record<string, number> = { [names.mine]: 501, [names.theirs]: 502, [names.root]: 0 }
    const looked: string[] = []
    const lstat = async (p: string): Promise<{ uid: number }> => {
      looked.push(p)
      const owner = owners[path.posix.basename(p)]
      if (owner === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { uid: owner }
    }
    expect(await otherHostFolders('linux', own, { uid: 501, lstat })).toEqual([slashed(path.join(parent, names.mine))])
    expect(await otherHostFolders('darwin', own, { uid: 502, lstat })).toEqual([slashed(path.join(parent, names.theirs))])
    // Each Host-shaped folder but this one is looked at by its own path; the unrelated one is not
    expect(looked.map((p) => path.posix.basename(p)).sort()).toEqual([...Object.values(names), ...Object.values(names)].sort())
  })
})
