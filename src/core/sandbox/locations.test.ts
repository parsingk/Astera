import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appKeyDenies, credentialStoreDenies, hostSocketDenies, installRootOf, localAsteraDir, otherHostFolders, profileReadOnly, publicShuttleFiles, sandboxReadOnly, sensitiveLocations, updaterCacheDir } from './locations'

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

  // Task E fix round 1: the folders Astera itself writes executable code or an installer to and later runs outside any
  // sandbox, beside the profile. electron-updater's download cache is <appCacheBase>/astera-updater on every OS (its
  // AppAdapter.getAppCacheDir at 6.8.9: LOCALAPPDATA, ~/Library/Caches, $XDG_CACHE_HOME|~/.cache).
  it('names the updater download cache where electron-updater keeps it, per OS', () => {
    expect(updaterCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe('C:/Users/a/AppData/Local/astera-updater')
    expect(updaterCacheDir('win32', {}, 'C:\\Users\\a')).toBe('C:/Users/a/AppData/Local/astera-updater')
    expect(updaterCacheDir('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Caches/astera-updater')
    expect(updaterCacheDir('linux', { XDG_CACHE_HOME: '/x/cache' }, '/h')).toBe('/x/cache/astera-updater')
    expect(updaterCacheDir('linux', {}, '/h')).toBe('/h/.cache/astera-updater')
  })

  // The installed app's own folder: on win32 the executable's folder (a per-user install under %LOCALAPPDATA%\Programs);
  // on macOS the enclosing .app bundle; on Linux the AppImage's own folder is the person's (a download dir), so none
  it('names the installed app’s folder on win32 and the .app bundle on macOS, and nothing on Linux', () => {
    expect(installRootOf('C:\\Users\\a\\AppData\\Local\\Programs\\Astera\\Astera.exe', 'win32')).toBe('C:/Users/a/AppData/Local/Programs/Astera')
    expect(installRootOf('/Applications/Astera.app/Contents/MacOS/Astera', 'darwin')).toBe('/Applications/Astera.app')
    expect(installRootOf('/Users/a/Applications/Astera.app/Contents/MacOS/Astera', 'darwin')).toBe('/Users/a/Applications/Astera.app')
    expect(installRootOf('/opt/Astera/astera', 'linux')).toBeNull()
    expect(installRootOf(null, 'win32')).toBeNull()
  })

  // One function builds the whole read-only list for a start: the profile, the Windows Host runtime base, the updater
  // cache, the install root, Astera's own %LOCALAPPDATA%\astera on Windows (the public CLI's bin, the session .cmd's
  // junction, the installed app's Host runtime) and on macOS and Linux the public CLI's own files. Nulls dropped,
  // forward slashes, each once
  it('builds the whole read-only list for a sandboxed start, dropping what is not known', () => {
    expect(
      sandboxReadOnly({
        profileDir: 'C:\\Users\\a\\AppData\\Roaming\\astera',
        hostRuntimeBase: 'C:\\Users\\a\\AppData\\Local\\astera\\host-runtime',
        updaterCache: 'C:/Users/a/AppData/Local/astera-updater',
        installRoot: 'C:/Users/a/AppData/Local/Programs/Astera',
        localAstera: 'C:/Users/a/AppData/Local/astera'
      })
    ).toEqual([
      'C:/Users/a/AppData/Roaming/astera',
      'C:/Users/a/AppData/Local/astera/host-runtime',
      'C:/Users/a/AppData/Local/astera-updater',
      'C:/Users/a/AppData/Local/Programs/Astera',
      'C:/Users/a/AppData/Local/astera'
    ])
    expect(sandboxReadOnly({ profileDir: '/h/.config/astera', publicShuttle: ['/h/.local/bin/astera'] })).toEqual(['/h/.config/astera', '/h/.local/bin/astera'])
    // The profile alone, as the measurement passes it (the runner has no real install, Host runtime or updater cache)
    expect(sandboxReadOnly({ profileDir: '/home/a/.config/astera' })).toEqual(['/home/a/.config/astera'])
    expect(sandboxReadOnly({})).toEqual([])
    // Deduped and slashed: the same path twice, and a trailing slash, collapse to one
    expect(sandboxReadOnly({ profileDir: '/p/', updaterCache: '/p' })).toEqual(['/p'])
  })

  // Task E fix round 2: on Windows %LOCALAPPDATA%\astera is Astera's own folder — the public CLI's `bin`
  // (cliInstall.ts binDirFor), the session .cmd's `app` junction (exec/shuttle.ts cmdLinkPath) and the installed app's
  // `host-runtime` — and nothing a sandboxed session writes lives there, so it is read-only whole; none off Windows
  it('names Astera’s own %LOCALAPPDATA%\\astera on Windows, and nothing off Windows', () => {
    expect(localAsteraDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe('C:/Users/a/AppData/Local/astera')
    expect(localAsteraDir('win32', {}, 'C:\\Users\\a')).toBe('C:/Users/a/AppData/Local/astera')
    expect(localAsteraDir('darwin', {}, '/Users/a')).toBeNull()
    expect(localAsteraDir('linux', {}, '/h')).toBeNull()
  })

  // Task E fix round 2: on macOS and Linux the public CLI's folder (~/.local/bin) is the person's, so only the files
  // Astera itself writes there are named, and only those that exist: a missing read-only path would have the sandbox
  // put a placeholder at it. None on Windows, where the whole folder is named instead
  it('names only the public CLI’s own files on macOS and Linux, where they exist', () => {
    const at = (present: string[]) => (p: string) => present.includes(p)
    expect(publicShuttleFiles({ platform: 'linux', binDir: '/h/.local/bin', names: ['astera'], exists: at(['/h/.local/bin/astera']) })).toEqual(['/h/.local/bin/astera'])
    expect(publicShuttleFiles({ platform: 'darwin', binDir: '/Users/a/.local/bin', names: ['astera'], exists: at([]) })).toEqual([])
    expect(publicShuttleFiles({ platform: 'win32', binDir: 'C:\\Users\\a\\AppData\\Local\\astera\\bin', names: ['astera.cmd', 'astera'], exists: () => true })).toEqual([])
    // A throwing look counts as not there
    expect(publicShuttleFiles({ platform: 'linux', binDir: '/h/.local/bin', names: ['astera'], exists: () => { throw new Error('EACCES') } })).toEqual([])
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
