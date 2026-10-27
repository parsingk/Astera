// The measuring run (enforce and sandbox design §8, E4): it writes fake credentials into the home folder, so it runs only
// on a GitHub Actions runner, and the workflow asks for both runners, the pinned CLIs and nothing beyond reading.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { busSocket, codexS2Args, main, probeEnv, s2Denied, srtArgv, srtS2Settings } from './measure-sandbox.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('measure-sandbox', () => {
  // Final review M12: a self-hosted runner, a person's own machine, sets GITHUB_ACTIONS too
  it('refuses to run anywhere but a GitHub-hosted runner', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-home-'))
    try {
      for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
        await expect(main({ env, home, root }), JSON.stringify(env)).rejects.toThrow(/only on a GitHub-hosted runner/)
      expect(readdirSync(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('asks the workflow for both runners, the pinned versions and no more than reading', () => {
    const yml = readFileSync(path.join(root, '.github/workflows/measure-sandbox.yml'), 'utf8')
    for (const want of [
      'macos-latest',
      'ubuntu-latest',
      '@openai/codex@0.160.0',
      '@anthropic-ai/sandbox-runtime@0.0.79',
      'contents: read',
      "branches: ['measure/**']",
      'bubblewrap',
      'socat',
      'ripgrep',
      'zsh',
      'kernel.apparmor_restrict_unprivileged_userns=0',
      // Found by the first run: without these the Linux keychain probe had nothing to read
      'libsecret-tools',
      'gnome-keyring',
      'dbus-daemon --session',
      'gnome-keyring-daemon --unlock',
      'node scripts/measure/measure-sandbox.mjs',
      'GH_TOKEN: ${{ github.token }}',
      // Final review M9 and M8
      'persist-credentials: false',
      'timeout-minutes: 45'
    ])
      expect(yml, want).toContain(want)
    // Nothing that writes back to the repository
    expect(yml).not.toMatch(/contents: write|git push/)
  })

  // Found by the first run: both S2 sets reached a keychain item on macOS
  it('denies the S2 sets the sensitive locations, and on macOS the keychains folder only when asked', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(s2Denied(platform)).toContain('~/.ssh')
      expect(s2Denied(platform)).not.toContain('~/Library/Keychains')
    }
    expect(s2Denied('darwin', true)).toEqual([...s2Denied('darwin'), '~/Library/Keychains'])
    expect(s2Denied('linux', true)).toEqual(s2Denied('linux'))
  })

  // Final review M9: only gh's preset run needs the job's token
  it('runs the probes without the job’s GitHub tokens', () => {
    const env = probeEnv({ GH_TOKEN: 'job', GITHUB_TOKEN: 'job', PATH: '/bin' }, '/h', '4321')
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ASTERA_PROBE_PORT: '4321' })
  })

  // Final review I1: a worktree's hooks and config are in its common directory, which the S2 sets make writable
  it('keeps the common directory’s hooks and config read-only in both S2 sets, in a repository and in a worktree', () => {
    const o = { commonDir: '/m/.git', denied: ['~/.ssh'], tmp: '/t' }
    for (const layout of ['repo', 'worktree']) {
      const args = codexS2Args({ ...o, layout }).join(' ')
      for (const want of ['"/m/.git"="write"', '"/m/.git/hooks"="read"', '"/m/.git/config"="read"', '"~/.ssh"="deny"', 'network={enabled=true}'])
        expect(args, `${layout} ${want}`).toContain(want)
      const s = srtS2Settings({ ...o, layout })
      expect(s.filesystem.allowWrite, layout).toEqual(['.', '/t', '/m/.git'])
      expect(s.filesystem.denyRead, layout).toEqual(['~/.ssh'])
    }
    // §6 keeps the workspace root's `.git` writable in both (found by run 3: without it Codex kept the worktree's git
    // directory read-only); in a worktree `.git` is a file, so nothing is said under it (srt could not mount there)
    expect(codexS2Args({ ...o, layout: 'repo' }).join(' ')).toContain('":workspace_roots"={".git"="write", ".git/hooks"="read", ".git/config"="read"}')
    expect(codexS2Args({ ...o, layout: 'worktree' }).join(' ')).toContain('":workspace_roots"={".git"="write"}, ')
    expect(srtS2Settings({ ...o, layout: 'repo' }).filesystem.denyWrite).toEqual(['.git/hooks', '.git/config', '/m/.git/hooks', '/m/.git/config'])
    expect(srtS2Settings({ ...o, layout: 'worktree' }).filesystem.denyWrite).toEqual(['/m/.git/hooks', '/m/.git/config'])
  })

  // Final review M3: srt took `sh -c`'s `-c` for its own option and ran the line with bash
  it('ends srt’s options before the probe’s shell', () => {
    expect(srtArgv('/s.json', 'true')).toEqual(['--settings', '/s.json', '--', 'sh', '-c', 'true'])
  })

  // Final review M10: whether a denied path closes the session bus is measured, not assumed
  it('finds the session bus socket a desktop names', () => {
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe('/run/user/1000/bus')
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/r/bus,guid=abc' })).toBe('/r/bus')
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x' })).toBeNull()
    expect(busSocket({})).toBeNull()
  })
})
