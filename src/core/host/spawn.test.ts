import { describe, it, expect } from 'vitest'
import { HOST_ONLY_ENV, hostSpawnPlan, hostWorkerBaseEnv, resolveHostEntry } from './spawn'

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
})
