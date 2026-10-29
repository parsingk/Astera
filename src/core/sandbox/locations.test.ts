import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appKeyDenies, appKeyEntries, credentialStoreDenies, credentialStoreEntries, ensureOwnFolders, hostSocketDenies, installRootOf, localAsteraDir, namedPathFor, namedPaths, otherHostFolders, presentOrNull, profileReadOnly, publicShuttleFiles, sandboxReadOnly, sensitiveEntries, sensitiveLocations, updaterCacheDir } from './locations'

describe('sandbox locations', () => {
  it('lists E6 on every OS, with gh and gcloud where each OS keeps them', () => {
    expect(sensitiveLocations('linux', {}, '/h')).toEqual(['/h/.ssh', '/h/.aws', '/h/.config/gh', '/h/.config/gcloud', '/h/.docker', '/h/.npmrc', '/h/.git-credentials', '/h/.kube'])
    const win = sensitiveLocations('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')
    expect(win).toContain('C:/Users/a/AppData/Roaming/GitHub CLI')
    expect(win).toContain('C:/Users/a/AppData/Roaming/gcloud')
    expect(win).toContain('C:/Users/a/.ssh')
  })

  // Task E fix round 6: each entry says whether it names a file or a folder, where the list is built, so a start can
  // treat a missing file apart from a missing folder (Codex's Windows sandbox makes a missing deny-read path a folder)
  it('says which entries are files and which are folders', () => {
    const files = (es: ReadonlyArray<{ path: string; kind: 'file' | 'folder' }>) => es.filter((e) => e.kind === 'file').map((e) => e.path)
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const e6 = sensitiveEntries(platform, { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, platform === 'win32' ? 'C:\\Users\\a' : '/h')
      expect(e6.map((e) => e.path), platform).toEqual(sensitiveLocations(platform, { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, platform === 'win32' ? 'C:\\Users\\a' : '/h'))
      expect(files(e6).map((p) => p.replace(/^.*\//, '')), platform).toEqual(['.npmrc', '.git-credentials'])
    }
    expect(credentialStoreEntries('darwin', {}, '/h')).toEqual([{ path: '/h/Library/Keychains', kind: 'folder' }])
    expect(credentialStoreEntries('linux', { XDG_RUNTIME_DIR: '/run/user/1' }, '/h')).toEqual([{ path: '/run/user/1/bus', kind: 'file' }])
    expect(credentialStoreEntries('win32', {}, 'C:\\Users\\a')).toEqual([])
    expect(appKeyEntries('C:\\p\\host\\app.key')).toEqual([{ path: 'C:/p/host/app.key', kind: 'file' }])
    expect(appKeyEntries(null)).toEqual([])
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

  // Task E fix round 3 (re-review Minor 5): the start names only paths that exist, each at its real path, on every OS — a
  // missing read-only path would have the sandbox put a placeholder file at it (the missing ~/.cache/astera-updater), and a
  // path through a symlinked ~/.cache or ~/.local would make Codex refuse every command on Linux
  it('names only paths that exist, each at its real path, when given a resolver', () => {
    const real: Record<string, string> = { '/h/.config/astera': '/h/.config/astera', '/h/.cache/astera-updater': '/dots/cache/astera-updater' }
    const resolve = (p: string): string | null => real[p] ?? null
    expect(
      sandboxReadOnly({ profileDir: '/h/.config/astera', updaterCache: '/h/.cache/astera-updater', installRoot: '/gone', publicShuttle: ['/h/.local/bin/astera'], resolve })
    ).toEqual(['/h/.config/astera', '/dots/cache/astera-updater'])
    // A resolver that throws drops the path
    expect(sandboxReadOnly({ profileDir: '/p', resolve: () => { throw new Error('EACCES') } })).toEqual([])
    // Fix round 5: what the wirings pass keeps a path that is there as it is spelled, a link on it included; where it
    // really is is decided at each start, by the session's own writable folders (namedPathFor)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-real-'))
    try {
      const d = dir.replace(/\\/g, '/')
      expect(presentOrNull(dir)).toBe(d)
      expect(presentOrNull(path.join(dir, 'missing'))).toBeNull()
      mkdirSync(path.join(dir, 'dots', 'cache', 'astera-updater'), { recursive: true })
      symlinkSync(path.join(dir, 'dots', 'cache'), path.join(dir, '.cache'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(presentOrNull(path.join(dir, '.cache', 'astera-updater'))).toBe(`${d}/.cache/astera-updater`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Task E fix round 5 (rule E5: a session whose protection cannot be put in place does not start). Every path Astera
  // names for a sandboxed start is looked at against that session's writable folders: a link on it the session cannot
  // change is followed, so the entry names where the path really is (through its nearest existing folder when the rest
  // is missing); a link it could change (one inside a writable folder) leaves the entry as given and is reported, since
  // a session could repoint it after the sandbox was built (Codex's bwrap.rs refuses such a path for that reason)
  describe('namedPathFor', () => {
    let dir: string
    let d: string
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    const tree = (): void => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'astera-named-'))
      d = realpathSync.native(dir).replace(/\\/g, '/')
      mkdirSync(path.join(d, 'home'))
      mkdirSync(path.join(d, 'home', 'dots', 'config', 'gh'), { recursive: true })
      mkdirSync(path.join(d, 'home', 'proj'))
      // ~/.config is a dotfile manager's link into ~/dots/config
      symlinkSync(path.join(d, 'home', 'dots', 'config'), path.join(d, 'home', '.config'), kind)
    }

    it('names a path with no link on it as given', () => {
      tree()
      expect(namedPathFor(`${d}/home/dots/config/gh`, [`${d}/home/proj`], process.platform)).toEqual({ path: `${d}/home/dots/config/gh`, link: null })
      expect(namedPathFor(`${d}/home/nothing/here`, [`${d}/home/proj`], process.platform)).toEqual({ path: `${d}/home/nothing/here`, link: null })
    })

    it('follows a link the session cannot change, through the nearest existing folder when the rest is missing', () => {
      tree()
      const roots = [`${d}/home/proj`, `${d}/tmp`]
      expect(namedPathFor(`${d}/home/.config/gh`, roots, process.platform)).toEqual({ path: `${d}/home/dots/config/gh`, link: null })
      expect(namedPathFor(`${d}/home/.config/gcloud`, roots, process.platform)).toEqual({ path: `${d}/home/dots/config/gcloud`, link: null })
      expect(namedPathFor(`${d}/home/.config/astera/host/app.key`, roots, process.platform)).toEqual({ path: `${d}/home/dots/config/astera/host/app.key`, link: null })
    })

    it('leaves a path through a link inside a writable folder as given, and names the link', () => {
      tree()
      // The work folder is the home: the session could repoint ~/.config
      expect(namedPathFor(`${d}/home/.config/gh`, [`${d}/home`], process.platform)).toEqual({ path: `${d}/home/.config/gh`, link: `${d}/home/.config` })
      expect(namedPathFor(`${d}/home/.config/gcloud`, [`${d}/home`], process.platform)).toEqual({ path: `${d}/home/.config/gcloud`, link: `${d}/home/.config` })
      // A writable folder above it holds it too
      expect(namedPathFor(`${d}/home/.config/gh`, [d], process.platform).link).toBe(`${d}/home/.config`)
    })

    it('looks at every link a chain goes through, by where each one lies', () => {
      tree()
      // ~/.config -> ~/dots/config (outside the work folder ~/proj), and ~/dots/config/gh -> ~/proj/gh-real (inside it)
      mkdirSync(path.join(d, 'home', 'proj', 'gh-real'))
      rmSync(path.join(d, 'home', 'dots', 'config', 'gh'), { recursive: true })
      symlinkSync(path.join(d, 'home', 'proj', 'gh-real'), path.join(d, 'home', 'dots', 'config', 'gh'), kind)
      // Neither link lies in ~/proj: both are followed, to a target that happens to be inside the work folder
      expect(namedPathFor(`${d}/home/.config/gh`, [`${d}/home/proj`], process.platform)).toEqual({ path: `${d}/home/proj/gh-real`, link: null })
      // The second link lies in ~/dots/config: inside the writable folder when that is ~/dots, outside when it is ~/proj
      expect(namedPathFor(`${d}/home/.config/gh`, [`${d}/home/dots`], process.platform)).toEqual({ path: `${d}/home/.config/gh`, link: `${d}/home/dots/config/gh` })
    })

    it.runIf(process.platform !== 'win32')('follows a relative link and a link to a file', () => {
      tree()
      symlinkSync('dots/config', path.join(d, 'home', '.config2'))
      writeFileSync(path.join(d, 'home', 'dots', 'npmrc'), '')
      symlinkSync(path.join(d, 'home', 'dots', 'npmrc'), path.join(d, 'home', '.npmrc'))
      expect(namedPathFor(`${d}/home/.config2/gh`, [`${d}/home/proj`], process.platform).path).toBe(`${d}/home/dots/config/gh`)
      expect(namedPathFor(`${d}/home/.npmrc`, [`${d}/home/proj`], process.platform)).toEqual({ path: `${d}/home/dots/npmrc`, link: null })
      expect(namedPathFor(`${d}/home/.npmrc`, [`${d}/home`], process.platform)).toEqual({ path: `${d}/home/.npmrc`, link: `${d}/home/.npmrc` })
    })

    it('names a path as given when a look fails or the links go round', () => {
      tree()
      const failing = { lstat: (): never => { throw new Error('EACCES') }, readlink: (): string => '', realpath: (p: string): string => { throw new Error(`EACCES ${p}`) } }
      expect(namedPathFor(`${d}/home/.config/gh`, [], process.platform, failing)).toEqual({ path: `${d}/home/.config/gh`, link: null })
      const looping = { lstat: () => ({ isSymbolicLink: () => true }), readlink: (p: string) => p, realpath: (p: string): string => { throw new Error(`ELOOP ${p}`) } }
      expect(namedPathFor('/a/b', [], 'linux', looping)).toEqual({ path: '/a/b', link: null })
    })

    it('compares the writable folders by both their spellings, case folded where the OS ignores case', () => {
      tree()
      // A work folder named through a link of its own still holds the link it is reached by
      symlinkSync(path.join(d, 'home'), path.join(d, 'home-link'), kind)
      expect(namedPathFor(`${d}/home/.config/gh`, [`${d}/home-link`], process.platform).link).toBe(`${d}/home/.config`)
      if (process.platform === 'win32') expect(namedPathFor(`${d}/home/.config/gh`, [`${d}/HOME`], 'win32').link).toBe(`${d}/home/.config`)
    })

    // Fix round 6 (re-review 2, Minor 1): replacing a link needs write access to the folder that holds it, so a link that
    // is a writable folder itself (a home-folder session whose home is a symlink) is one the session cannot change
    it('follows a link that is a writable folder itself, judging every link by the folder that holds it', () => {
      tree()
      symlinkSync(path.join(d, 'home'), path.join(d, 'home-link'), kind)
      expect(namedPathFor(`${d}/home-link/dots/config/gh`, [`${d}/home-link`], process.platform)).toEqual({ path: `${d}/home/dots/config/gh`, link: null })
      // A link inside it is still one the session could change, by either spelling of the folder
      expect(namedPathFor(`${d}/home-link/.config/gh`, [`${d}/home-link`], process.platform)).toEqual({ path: `${d}/home-link/.config/gh`, link: `${d}/home/.config` })
    })

    // CI fix (run 40809399938, Windows): a folder can be spelled by its 8.3 short name (GitHub's Windows runner gives
    // TEMP as C:\Users\RUNNER~1\...), which is no link, so the walk kept it. The path is named by its canonical spelling,
    // the one every sandbox resolves to (Codex's Windows sandbox canonicalizes each path it protects), and a link is
    // judged by its folder's canonical spelling, so a short-spelled path cannot slip past a long-spelled work folder
    describe('the canonical spelling', () => {
      const SHORT = 'C:/Users/RUNNER~1'
      const LONG = 'C:\\Users\\runneradmin'
      const existing = new Set(['C:/Users', SHORT, `${SHORT}/AppData`, `${SHORT}/AppData/Temp`, `${SHORT}/AppData/Temp/profile`])
      const look = {
        lstat: (p: string) => (p === `${SHORT}/.ssh` ? { isSymbolicLink: () => true } : existing.has(p) ? { isSymbolicLink: () => false } : null),
        readlink: () => `${LONG}\\dots\\ssh`,
        realpath: (p: string) => {
          if (!existing.has(p) && p !== 'C:/') throw new Error(`ENOENT ${p}`)
          return p.startsWith(SHORT) ? LONG + p.slice(SHORT.length).replace(/\//g, '\\') : p.replace(/\//g, '\\')
        }
      }

      it('names an existing path, and the folders above a missing one, by their long names', () => {
        expect(namedPathFor(`${SHORT}/AppData/Temp/profile`, [], 'win32', look)).toEqual({ path: 'C:/Users/runneradmin/AppData/Temp/profile', link: null })
        expect(namedPathFor(`${SHORT}/AppData/Temp/profile/host/app.key`, [], 'win32', look)).toEqual({ path: 'C:/Users/runneradmin/AppData/Temp/profile/host/app.key', link: null })
        expect(namedPathFor(`${SHORT}/.npmrc`, [], 'win32', look)).toEqual({ path: 'C:/Users/runneradmin/.npmrc', link: null })
      })

      it('judges a link by its folder’s long name, so a short spelling is still inside a long-spelled work folder', () => {
        expect(namedPathFor(`${SHORT}/.ssh/id`, ['C:/Users/runneradmin'], 'win32', look)).toEqual({ path: `${SHORT}/.ssh/id`, link: `${SHORT}/.ssh` })
      })
    })

    // CI fix (run 40809399938, macOS): the system's own links (/var, /tmp and /etc into /private) lie in /, which no
    // session can write, so they are followed, never taken for a link the session could change, even when /tmp itself
    // is a writable folder. Under round 5's rule (a link judged by itself) /tmp counted as one, refusing every sandboxed
    // start whose paths go through it
    it('follows the macOS system links into /private, whatever the session may write', () => {
      const dirs = new Set(['/private', '/private/var', '/private/var/folders', '/private/var/folders/x', '/private/tmp', '/private/etc', '/Users', '/Users/u'])
      const links: Record<string, string> = { '/var': 'private/var', '/tmp': 'private/tmp', '/etc': 'private/etc' }
      const look = {
        lstat: (p: string) => (p in links ? { isSymbolicLink: () => true } : dirs.has(p) ? { isSymbolicLink: () => false } : null),
        readlink: (p: string) => links[p],
        realpath: (p: string): string => {
          if (!dirs.has(p) && p !== '/') throw new Error(`ENOENT ${p}`)
          return p
        }
      }
      const writable = ['/tmp', '/var/folders/x/T', '/Users/u/proj']
      expect(namedPathFor('/var/folders/x/T/astera/host/app.key', writable, 'darwin', look)).toEqual({ path: '/private/var/folders/x/T/astera/host/app.key', link: null })
      expect(namedPathFor('/tmp/astera-host-1', writable, 'darwin', look)).toEqual({ path: '/private/tmp/astera-host-1', link: null })
      expect(namedPathFor('/etc/ssh/ssh_config.d', writable, 'darwin', look)).toEqual({ path: '/private/etc/ssh/ssh_config.d', link: null })
    })

    // Fix round 6 (re-review 2, Minor 4): a link to a network share (`\\server\share`, or `\\?\UNC\server\share`) is not
    // a relative one; its path is named as given
    it('names a path through a link to a network share as given', () => {
      for (const target of ['\\\\srv\\share\\gcloud', '\\\\?\\UNC\\srv\\share\\gcloud', '//srv/share/gcloud']) {
        const look = {
          lstat: (p: string) => (p === '/a' ? { isSymbolicLink: () => false } : p === '/a/gcloud' ? { isSymbolicLink: () => true } : null),
          readlink: () => target,
          realpath: (p: string): string => { throw new Error(`ENOENT ${p}`) }
        }
        expect(namedPathFor('/a/gcloud/creds', [], 'win32', look), target).toEqual({ path: '/a/gcloud/creds', link: null })
      }
      // A drive path behind the long-path prefix is followed as before
      const drive = {
        lstat: (p: string) => (p === '/a' || p === 'D:/' || p === 'D:/real' ? { isSymbolicLink: () => false } : p === '/a/gcloud' ? { isSymbolicLink: () => true } : null),
        readlink: () => '\\\\?\\D:\\real',
        realpath: (p: string): string => { throw new Error(`ENOENT ${p}`) }
      }
      expect(namedPathFor('/a/gcloud/creds', [], 'win32', drive)).toEqual({ path: 'D:/real/creds', link: null })
    })

    it('collects a list: each entry where it is named, once, and the links that left one as given', () => {
      tree()
      const r = namedPaths([`${d}/home/.config/gh`, `${d}/home/dots/config/gh`, `${d}/home/.config/gcloud`], [`${d}/home/proj`], process.platform)
      expect(r).toEqual({ paths: [`${d}/home/dots/config/gh`, `${d}/home/dots/config/gcloud`], links: [] })
      const inHome = namedPaths([`${d}/home/.config/gh`, `${d}/home/.config/gcloud`], [`${d}/home`], process.platform)
      expect(inHome).toEqual({ paths: [`${d}/home/.config/gh`, `${d}/home/.config/gcloud`], links: [`${d}/home/.config`] })
    })
  })

  // Task E fix round 4: the folders Astera owns and writes an installer or a runtime into (electron-updater's cache, the
  // Windows Host runtime) are made, empty, before the list is built, so the list always names them: one first made by a
  // download while the app runs would otherwise stay writable until the next start. Never a file, and nothing else
  it('makes the folders it is given that are missing, leaves the others, and never throws', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-own-'))
    try {
      const cache = path.join(dir, 'cache', 'astera-updater')
      const runtime = path.join(dir, 'local', 'astera', 'host-runtime')
      mkdirSync(runtime, { recursive: true })
      writeFileSync(path.join(runtime, 'kept'), 'x')
      ensureOwnFolders([cache, runtime, null, undefined])
      expect(statSync(cache).isDirectory()).toBe(true)
      expect(readdirSync(cache)).toEqual([])
      expect(readdirSync(runtime)).toEqual(['kept'])
      // One that cannot be made is left to the resolver, which then leaves it out; the start goes on
      const made: string[] = []
      expect(() =>
        ensureOwnFolders(['/a', '/b'], (p) => {
          made.push(p)
          if (p === '/a') throw new Error('EACCES')
        })
      ).not.toThrow()
      expect(made).toEqual(['/a', '/b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
