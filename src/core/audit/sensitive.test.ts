// The login folder a call touched (lifecycle design §4.10): a record keeps the E6 location's short name, never the path.
// The homes are built under the temp folder, so the same tests hold on win32 and POSIX.
import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { sensitiveEntries } from '../sandbox/locations'
import { SENSITIVE_NAMES, homePathOf, homeSensitiveNameOf, sensitiveNameOf } from './sensitive'

const home = path.join(os.tmpdir(), 'h')
const entries = sensitiveEntries(process.platform, {}, home)
const under = (...p: string[]): string => path.join(home, ...p)
const nameOf = (p: string): string | null => sensitiveNameOf(p, entries, process.platform)

describe('sensitiveNameOf', () => {
  it('names .ssh for a file under it and for the folder itself', () => {
    expect(nameOf(under('.ssh', 'id_rsa'))).toBe('.ssh')
    expect(nameOf(under('.ssh'))).toBe('.ssh')
    expect(nameOf(under('.ssh') + path.sep)).toBe('.ssh')
    // Either separator, as a path reaches it from a shell
    expect(nameOf(under('.ssh', 'id_rsa').replace(/\\/g, '/'))).toBe('.ssh')
  })

  it('is case-insensitive on win32 and darwin, exact on linux', () => {
    const upper = under('.SSH', 'id_rsa')
    for (const platform of ['win32', 'darwin'] as const) expect(sensitiveNameOf(upper, sensitiveEntries(platform, {}, home), platform), platform).toBe('.ssh')
    expect(sensitiveNameOf(upper, sensitiveEntries('linux', {}, home), 'linux')).toBeNull()
    expect(sensitiveNameOf(under('.ssh', 'id_rsa'), sensitiveEntries('linux', {}, home), 'linux')).toBe('.ssh')
  })

  it('names .npmrc only for the file, not for .npmrc-old', () => {
    expect(nameOf(under('.npmrc'))).toBe('.npmrc')
    expect(nameOf(under('.npmrc-old'))).toBeNull()
    expect(nameOf(under('.git-credentials'))).toBe('.git-credentials')
    // A folder's name is not a prefix of another's either
    expect(nameOf(under('.sshx', 'a'))).toBeNull()
  })

  it('names every E6 location by its short name, the GitHub CLI as gh on Windows too', () => {
    const roaming = under('AppData', 'Roaming')
    const win = sensitiveEntries('win32', { APPDATA: roaming }, home)
    expect(sensitiveNameOf(path.join(roaming, 'GitHub CLI', 'hosts.yml'), win, 'win32')).toBe('gh')
    expect(sensitiveNameOf(path.join(roaming, 'gcloud', 'credentials.db'), win, 'win32')).toBe('gcloud')
    const posix = sensitiveEntries('linux', {}, home)
    expect(sensitiveNameOf(under('.config', 'gh', 'hosts.yml'), posix, 'linux')).toBe('gh')
    expect(sensitiveNameOf(under('.config', 'gcloud'), posix, 'linux')).toBe('gcloud')
    expect(sensitiveNameOf(under('.aws', 'credentials'), posix, 'linux')).toBe('.aws')
    expect(sensitiveNameOf(under('.docker', 'config.json'), posix, 'linux')).toBe('.docker')
    expect(sensitiveNameOf(under('.kube', 'config'), posix, 'linux')).toBe('.kube')
    expect([...SENSITIVE_NAMES].sort()).toEqual(['.aws', '.docker', '.git-credentials', '.kube', '.npmrc', '.ssh', 'gcloud', 'gh', 'unknown'])
  })

  it('reads a path that climbs back out of a folder where it ends', () => {
    expect(nameOf(`${under('.ssh')}/../notes.txt`)).toBeNull()
    expect(nameOf(`${under('src')}/../.ssh/id_rsa`)).toBe('.ssh')
  })

  // Fix round 1, Minor 3: a list's entries are worked out once for each case rule, and one list serves both
  it('answers each case rule from the same list, however often it is asked', () => {
    const upper = under('.SSH', 'id_rsa')
    for (let i = 0; i < 3; i++) {
      expect(sensitiveNameOf(upper, entries, 'win32')).toBe('.ssh')
      expect(sensitiveNameOf(upper, entries, 'linux')).toBeNull()
      expect(sensitiveNameOf(under('.ssh', 'id_rsa'), entries, 'linux')).toBe('.ssh')
    }
  })

  it('returns null for a path outside every entry', () => {
    expect(nameOf(under('notes.txt'))).toBeNull()
    expect(nameOf(home)).toBeNull()
    expect(nameOf(path.join(os.tmpdir(), 'other', '.ssh', 'id_rsa'))).toBeNull()
    expect(sensitiveNameOf(under('.ssh', 'id_rsa'), [], process.platform)).toBeNull()
  })
})

describe('homeSensitiveNameOf', () => {
  it('homeSensitiveNameOf reads ~/.aws/credentials, $HOME/.kube/config and %USERPROFILE%\\.ssh\\id_rsa', () => {
    expect(homeSensitiveNameOf('~/.aws/credentials', entries, home)).toBe('.aws')
    expect(homeSensitiveNameOf('$HOME/.kube/config', entries, home)).toBe('.kube')
    expect(homeSensitiveNameOf('%USERPROFILE%\\.ssh\\id_rsa', entries, home)).toBe('.ssh')
    expect(homeSensitiveNameOf('${HOME}/.docker/config.json', entries, home)).toBe('.docker')
    expect(homeSensitiveNameOf('$env:USERPROFILE\\.git-credentials', entries, home)).toBe('.git-credentials')
    expect(homeSensitiveNameOf('~\\.ssh', entries, home)).toBe('.ssh')
    expect(homeSensitiveNameOf('~/.npmrc', entries, home)).toBe('.npmrc')
    // Windows reads its own variables in any case
    expect(homeSensitiveNameOf('$ENV:userprofile/.ssh/id_rsa', entries, home)).toBe('.ssh')
    expect(homeSensitiveNameOf('%UserProfile%/.ssh/id_rsa', entries, home)).toBe('.ssh')
  })

  // Fix round 1, Minor 5
  it('reads PowerShell’s spellings of the home in any case, and a POSIX shell’s with its case', () => {
    for (const p of ['$home\\.ssh\\id_rsa', '$HOME\\.ssh\\id_rsa', '${env:USERPROFILE}\\.ssh\\id_rsa', '$env:HOME\\.ssh\\id_rsa', '$Env:UserProfile\\.ssh\\id_rsa', '${Home}/.ssh']) {
      expect(homeSensitiveNameOf(p, entries, home, true), p).toBe('.ssh')
    }
    // `$env:` and `%USERPROFILE%` are Windows' own wherever they are written; `$home` is PowerShell's only
    expect(homeSensitiveNameOf('${ENV:userprofile}/.ssh', entries, home)).toBe('.ssh')
    expect(homeSensitiveNameOf('$env:home/.ssh', entries, home)).toBe('.ssh')
    expect(homeSensitiveNameOf('$home/.ssh/id_rsa', entries, home)).toBeNull()
    expect(homePathOf('$home/.ssh/id_rsa', home)).toBeNull()
    expect(homePathOf('${Home}/.ssh/id_rsa', home)).toBeNull()
    expect(homeSensitiveNameOf('$HOME/.ssh/id_rsa', entries, home)).toBe('.ssh')
  })

  it('returns null for a home path outside every entry, and for what is no home spelling', () => {
    expect(homeSensitiveNameOf('~/notes.txt', entries, home)).toBeNull()
    expect(homeSensitiveNameOf('~', entries, home)).toBeNull()
    expect(homeSensitiveNameOf('~/.ssh/../notes.txt', entries, home)).toBeNull()
    // Someone else's home, another variable, a longer name, and an absolute path are not this home
    expect(homeSensitiveNameOf('~user/.ssh/id_rsa', entries, home)).toBeNull()
    expect(homeSensitiveNameOf('$HOMEDIR/.ssh/id_rsa', entries, home)).toBeNull()
    expect(homeSensitiveNameOf('$X/.ssh/id_rsa', entries, home)).toBeNull()
    expect(homeSensitiveNameOf(under('.ssh', 'id_rsa'), entries, home)).toBeNull()
    // A variable past the home could name anything
    expect(homeSensitiveNameOf('$HOME/$X/id_rsa', entries, home)).toBeNull()
    // No home known: nothing is placed from it
    expect(homeSensitiveNameOf('~/.ssh/id_rsa', entries, '')).toBeNull()
  })
})
