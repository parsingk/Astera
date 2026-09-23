import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../types'
import { makeDescriptors } from '../providers/descriptor'
import { cliEnvFor } from '../sessions/cliEnv'
import { HOST_ONLY_ENV, hostCliPaths, hostSpawnPlan, hostWorkerBaseEnv, resolveHostEntry } from './spawn'

describe('resolveHostEntry', () => {
  it('takes the first candidate that exists', () => {
    expect(resolveHostEntry(['/a/host.js', '/b/host.js'], (p) => p === '/b/host.js')).toBe('/b/host.js')
  })

  it('is null when the bundle was never emitted', () => {
    expect(resolveHostEntry(['/a/host.js'], () => false)).toBeNull()
  })
})

describe('hostSpawnPlan', () => {
  const plan = hostSpawnPlan({
    execPath: 'C:/Program Files/Astera/Astera.exe',
    entryPath: 'C:/Program Files/Astera/resources/app.asar/out/main/host.js',
    profileDir: 'C:/Users/someone/AppData/Roaming/astera',
    logPath: 'C:/Users/someone/AppData/Roaming/astera/host/host.log',
    version: '1.3.16'
  })

  // The app's own binary runs the bundle as plain Node, which is how the astera CLI shuttle avoids
  // shipping a second runtime.
  it('runs the app binary as node, on the host bundle', () => {
    expect(plan.command).toBe('C:/Program Files/Astera/Astera.exe')
    expect(plan.args).toEqual(['C:/Program Files/Astera/resources/app.asar/out/main/host.js'])
    expect(plan.options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('tells the Host where its profile and its log are', () => {
    expect(plan.options.env.ASTERA_HOST_PROFILE_DIR).toBe('C:/Users/someone/AppData/Roaming/astera')
    expect(plan.options.env.ASTERA_HOST_LOG).toBe('C:/Users/someone/AppData/Roaming/astera/host/host.log')
    expect(plan.options.env.ASTERA_HOST_VERSION).toBe('1.3.16')
  })

  // detached plus ignored stdio is what lets the app exit without taking the Host with it, and
  // without waiting on pipes nobody reads.
  it('is detached and holds no pipes', () => {
    expect(plan.options.detached).toBe(true)
    expect(plan.options.stdio).toBe('ignore')
  })

  // The Host outlives the app by at least a minute, and from slice 3 indefinitely. Inheriting the
  // app's working directory would pin whatever folder the app was launched from: on win32 that blocks
  // deleting the install directory, on posix it keeps a mount busy.
  it('runs from the profile directory rather than wherever the app was launched', () => {
    expect(plan.options.cwd).toBe('C:/Users/someone/AppData/Roaming/astera')
  })

  // The Host must not inherit the app's own agent-session variables: it is not a worker, and slice 2
  // will spawn workers from it.
  it('does not pass the app session variables through', () => {
    const dirty = hostSpawnPlan({
      execPath: 'x',
      entryPath: 'y',
      profileDir: 'p',
      logPath: 'l',
      version: 'v',
      env: { PATH: '/usr/bin', ASTERA_SESSION: 'sess-1', CLAUDE_CODE_SESSION_ID: 'c-1' }
    })
    expect(dirty.options.env.PATH).toBe('/usr/bin')
    expect('ASTERA_SESSION' in dirty.options.env).toBe(false)
    expect('CLAUDE_CODE_SESSION_ID' in dirty.options.env).toBe(false)
  })
})

describe('hostWorkerBaseEnv', () => {
  // D4: a worker gets the Host's environment minus what the Host's own start put there.
  it('drops ELECTRON_RUN_AS_NODE and every ASTERA_HOST_ variable and keeps the rest', () => {
    const base = hostWorkerBaseEnv({
      PATH: '/usr/bin',
      CI_SECRET: 'kept on purpose (D4)',
      ELECTRON_RUN_AS_NODE: '1',
      ASTERA_HOST_PROFILE_DIR: 'p',
      ASTERA_HOST_LOG: 'l',
      ASTERA_HOST_VERSION: 'v',
      ASTERA_HOST_CLI_EXEC: 'x'
    })
    expect(base).toEqual({ PATH: '/usr/bin', CI_SECRET: 'kept on purpose (D4)' })
  })

  it('matches whatever case the environment block spelled the key in', () => {
    expect(HOST_ONLY_ENV.test('electron_run_as_node')).toBe(true)
    expect(HOST_ONLY_ENV.test('Astera_Host_Log')).toBe(true)
    expect(HOST_ONLY_ENV.test('ELECTRON_RUN_AS_NODE_EXTRA')).toBe(false)
  })

  // Every variable hostSpawnPlan adds is one the strip list removes — the list cannot fall behind.
  it('removes everything hostSpawnPlan itself adds', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: {} })
    expect(hostWorkerBaseEnv(plan.options.env)).toEqual({})
  })

  // The CLI paths are the Host's own start-up settings too, and a worker must not see them (F1).
  it('removes the CLI paths hostSpawnPlan adds as well', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: {},
      cli: { exec: 'e', entry: 'n', skills: 's' } })
    expect(plan.options.env.ASTERA_HOST_CLI_EXEC).toBe('e')
    expect(hostWorkerBaseEnv(plan.options.env)).toEqual({})
  })
})

describe('the CLI paths the Host is started with', () => {
  it('ride the environment when given', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: {},
      cli: { exec: 'C:/A/Astera.exe', entry: 'C:/A/out/main/cli.js', skills: 'C:/A/resources/skills' } })
    expect(plan.options.env.ASTERA_HOST_CLI_EXEC).toBe('C:/A/Astera.exe')
    expect(plan.options.env.ASTERA_HOST_CLI_ENTRY).toBe('C:/A/out/main/cli.js')
    expect(plan.options.env.ASTERA_HOST_SKILLS).toBe('C:/A/resources/skills')
  })
  it('are absent when not given — an older caller starts a Host that does not spawn', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: {} })
    expect('ASTERA_HOST_CLI_EXEC' in plan.options.env).toBe(false)
  })
  // M2: a caller that could not name the paths must not start a Host that spawns with an ancestor's.
  it('are absent when not given even if the parent environment carries them', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v',
      env: { PATH: '/usr/bin', ASTERA_HOST_CLI_EXEC: 'old-e', astera_host_cli_entry: 'old-n', ASTERA_HOST_SKILLS: 'old-s', ASTERA_HOST_LOG: 'old-l' } })
    const names = Object.keys(plan.options.env).map((k) => k.toUpperCase())
    expect(names).not.toContain('ASTERA_HOST_CLI_EXEC')
    expect(names).not.toContain('ASTERA_HOST_CLI_ENTRY')
    expect(names).not.toContain('ASTERA_HOST_SKILLS')
    expect(plan.options.env.ASTERA_HOST_LOG).toBe('l')
    expect(plan.options.env.PATH).toBe('/usr/bin')
  })
  it('read back as the three paths, or the names of the ones missing', () => {
    const env = { ASTERA_HOST_CLI_EXEC: 'e', ASTERA_HOST_CLI_ENTRY: 'n', ASTERA_HOST_SKILLS: 's' }
    expect(hostCliPaths(env, () => true)).toEqual({ exec: 'e', entry: 'n', skills: 's' })
    expect(hostCliPaths({ ASTERA_HOST_CLI_EXEC: 'e' }, () => true)).toEqual({ missing: ['ASTERA_HOST_CLI_ENTRY', 'ASTERA_HOST_SKILLS'] })
    // a path that is named but not there is missing too — the Host does not guess (§2.2)
    expect(hostCliPaths(env, (p) => p !== 'n')).toEqual({ missing: ['ASTERA_HOST_CLI_ENTRY'] })
  })

  // C1: in a packaged build the entry is inside app.asar, and the Host runs as plain node.exe, whose
  // fs has no asar layer. The worker runs the entry through Electron, which reads asar, so the Host
  // checks the archive file itself.
  describe('an entry inside an asar archive', () => {
    const asar = String.raw`C:\A\resources\app.asar`
    const entry = String.raw`C:\A\resources\app.asar\out\main\cli.js`
    const exec = String.raw`C:\A\Astera.exe`
    const skills = String.raw`C:\A\resources\skills`
    const env = { ASTERA_HOST_CLI_EXEC: exec, ASTERA_HOST_CLI_ENTRY: entry, ASTERA_HOST_SKILLS: skills }

    it('counts as there when the archive file is, although plain fs cannot see inside it', () => {
      const onDisk = new Set([asar, exec, skills])
      expect(hostCliPaths(env, (p) => onDisk.has(p))).toEqual({ exec, entry, skills })
    })
    it('is missing when the archive file is not there', () => {
      const onDisk = new Set([exec, skills])
      expect(hostCliPaths(env, (p) => onDisk.has(p))).toEqual({ missing: ['ASTERA_HOST_CLI_ENTRY'] })
    })
    it('checks up to the first .asar segment only, with either slash', () => {
      const nested = 'C:/A/resources/app.asar/x/inner.asar/cli.js'
      const onDisk = new Set(['C:/A/resources/app.asar', exec, skills])
      expect(hostCliPaths({ ...env, ASTERA_HOST_CLI_ENTRY: nested }, (p) => onDisk.has(p))).toEqual({ exec, entry: nested, skills })
    })
    it('does not treat a name that merely contains .asar as an archive', () => {
      const lookalike = 'C:/A/app.asar.bak/cli.js'
      const onDisk = new Set(['C:/A/app.asar.bak', exec, skills])
      expect(hostCliPaths({ ...env, ASTERA_HOST_CLI_ENTRY: lookalike }, (p) => onDisk.has(p))).toEqual({ missing: ['ASTERA_HOST_CLI_ENTRY'] })
    })
    // The real failure, against the real fs: vitest runs as plain Node, like the Host's node.exe.
    it('counts as there against plain Node fs, where a path through a file is ENOTDIR', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'astera-asar-'))
      try {
        const archive = path.join(root, 'app.asar')
        writeFileSync(archive, 'not a directory')
        const skillsDir = path.join(root, 'skills')
        mkdirSync(skillsDir)
        const exe = path.join(root, 'Astera.exe')
        writeFileSync(exe, '')
        const inner = path.join(archive, 'out', 'main', 'cli.js')
        expect(existsSync(inner)).toBe(false)
        const real = { ASTERA_HOST_CLI_EXEC: exe, ASTERA_HOST_CLI_ENTRY: inner, ASTERA_HOST_SKILLS: skillsDir }
        expect(hostCliPaths(real, existsSync)).toEqual({ exec: exe, entry: inner, skills: skillsDir })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
    it('checks the executable and the skills folder the same way', () => {
      const inAsar = { ASTERA_HOST_CLI_EXEC: 'C:/A/app.asar/node.exe', ASTERA_HOST_CLI_ENTRY: entry, ASTERA_HOST_SKILLS: 'C:/A/app.asar/skills' }
      expect(hostCliPaths(inAsar, (p) => p === asar || p === 'C:/A/app.asar')).toEqual({
        exec: 'C:/A/app.asar/node.exe', entry, skills: 'C:/A/app.asar/skills'
      })
    })
  })
})

// §11's first risk: a worker the Host spawns and one the app spawns must see the same agent
// settings. Only the parent session's identity is stripped on the way to the Host (I1).
describe('Host worker env parity with an app worker', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_CHILD_SESSION: '1'
  }
  const account: Account = { id: 'a', label: 'a', configDir: '/cfg/a', color: '#fff', createdAt: '2026-09-24T00:00:00Z' }
  const descriptor = makeDescriptors(process.platform).claude
  const claudeKeys = (env: NodeJS.ProcessEnv): Record<string, string | undefined> =>
    Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('CLAUDE_CODE_')).sort())

  it('agrees with an app worker on every CLAUDE_CODE_ key', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: parent })
    const hostWorker = cliEnvFor({ base: hostWorkerBaseEnv(plan.options.env), account, descriptor, homeDir: '/home/u' })
    const appWorker = cliEnvFor({ base: parent, account, descriptor, homeDir: '/home/u' })
    expect(claudeKeys(hostWorker)).toEqual(claudeKeys(appWorker))
    expect(hostWorker.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect('CLAUDE_CODE_SESSION_ID' in hostWorker).toBe(false)
  })

  it('still keeps the parent session identity away from the Host itself', () => {
    const plan = hostSpawnPlan({ execPath: 'x', entryPath: 'y', profileDir: 'p', logPath: 'l', version: 'v', env: parent })
    expect('CLAUDE_CODE_SESSION_ID' in plan.options.env).toBe(false)
    expect('CLAUDE_CODE_CHILD_SESSION' in plan.options.env).toBe(false)
    expect(plan.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok')
  })
})
