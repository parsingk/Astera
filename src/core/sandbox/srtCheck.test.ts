// A Claude Job's checks on macOS and Linux run under the runtime Claude Code builds its sandbox on (Task K, the person's
// Q2): @anthropic-ai/sandbox-runtime 0.0.79 in library mode, through Astera's own small runner, with the settings a
// session's twin holds. No srt runs here: the module, the spawn and the folder are fakes.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { claudeSandboxSettings } from './claudeSettings'
import type { GitLayout } from './gitLayout'
import { SRT_RUNTIME_FILES, runInSrt, srtCheckRunner, srtConfigOf, srtHelpersOf, type SrtModule } from './srtCheck'

const part = claudeSandboxSettings({
  platform: 'linux',
  denied: ['/home/t/.ssh', '/home/t/.aws'],
  readOnly: ['/home/t/.config/astera'],
  npmCache: '/tmp/astera-npm-cache',
  layout: null
}).sandbox!

const worktree: GitLayout = {
  cwd: '/w/wt',
  top: '/w/wt',
  gitDir: '/w/main/.git/worktrees/wt',
  commonDir: '/w/main/.git',
  worktree: true,
  worktreeConfigs: [],
  gitFiles: []
}

describe('srtConfigOf', () => {
  it("the session's sandbox as srt takes it: its reads denied, its folder and npm's cache writable, its read-only folders not", () => {
    expect(srtConfigOf(part, { cwd: '/w/repo', layout: null })).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: ['/home/t/.ssh', '/home/t/.aws'], allowRead: [], allowWrite: ['/w/repo', '/tmp/astera-npm-cache'], denyWrite: ['/home/t/.config/astera'] }
    })
  })

  it("a worktree's common directory writable, as Claude Code makes it, with its hooks and config kept read-only", () => {
    const boxed = claudeSandboxSettings({ platform: 'linux', denied: [], readOnly: [], npmCache: '/tmp/c', layout: worktree }).sandbox!
    const c = srtConfigOf(boxed, { cwd: '/w/wt', layout: worktree })
    expect(c.filesystem.allowWrite).toEqual(['/w/wt', '/tmp/c', '/w/main/.git'])
    expect(c.filesystem.denyWrite).toEqual(expect.arrayContaining(['/w/main/.git/hooks', '/w/main/.git/config']))
    expect(new Set(c.filesystem.denyWrite).size).toBe(c.filesystem.denyWrite.length)
  })
})

/** A fake srt: records what it was asked, wraps a command as `wrapped:<command>`. */
function fakeSrt(o: { errors?: string[]; initializeFails?: string; resetFails?: string } = {}) {
  const calls: Array<{ op: string; arg?: unknown }> = []
  let ask: ((p: { host: string; port: number }) => Promise<boolean>) | undefined
  const srt: SrtModule = {
    SandboxManager: {
      initialize: async (config, cb) => {
        calls.push({ op: 'initialize', arg: config })
        ask = cb
        if (o.initializeFails) throw new Error(o.initializeFails)
      },
      wrapWithSandbox: async (command) => (calls.push({ op: 'wrap', arg: command }), `wrapped:${command}`),
      cleanupAfterCommand: () => void calls.push({ op: 'cleanup' }),
      reset: async () => {
        calls.push({ op: 'reset' })
        if (o.resetFails) throw new Error(o.resetFails)
      },
      checkDependencies: () => ({ errors: o.errors ?? [], warnings: [] })
    }
  }
  return { srt, calls, ask: (p: { host: string; port: number }) => ask!(p) }
}

/** A child that exits when told. */
const child = () => Object.assign(new EventEmitter(), { kill: (_s?: NodeJS.Signals) => true })

describe('runInSrt', () => {
  const payload = { config: srtConfigOf(part, { cwd: '/w/repo', layout: null }), cwd: '/w/repo', command: 'npm run test' }

  it('wraps the command under the config with every host allowed, runs it in its folder without Astera node flag, and exits with it', async () => {
    const f = fakeSrt()
    const made: string[] = []
    const spawned: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }> = []
    const kid = child()
    const done = runInSrt({
      payload,
      load: async () => f.srt,
      spawn: (command, opts) => (spawned.push({ command, ...opts }), kid),
      mkdir: (d) => void made.push(d),
      env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }
    })
    await new Promise((r) => setTimeout(r, 0))
    // Network allowed, as Claude Code in bypass allows a host outside the list (no list, every host asked and allowed)
    expect(await f.ask({ host: 'registry.npmjs.org', port: 443 })).toBe(true)
    expect(made).toEqual(['/tmp/claude'])
    expect(spawned).toEqual([{ command: 'wrapped:npm run test', cwd: '/w/repo', env: { PATH: '/bin' } }])
    kid.emit('exit', 3, null)
    expect(await done).toBe(3)
    expect(f.calls.map((c) => c.op)).toEqual(['initialize', 'wrap', 'cleanup', 'reset'])
    expect(f.calls[0].arg).toEqual(payload.config)
  })

  it("hands srt the helpers' real paths with the check's configuration", async () => {
    const f = fakeSrt()
    const kid = child()
    const helpers = { seccomp: { applyPath: '/u/apply-seccomp' }, javaAgentJarPath: '/u/agent.jar' }
    const done = runInSrt({ payload, helpers, load: async () => f.srt, spawn: () => kid, mkdir: () => {}, env: {} })
    await new Promise((r) => setTimeout(r, 0))
    kid.emit('exit', 0, null)
    expect(await done).toBe(0)
    expect(f.calls[0].arg).toEqual({ ...payload.config, ...helpers })
  })

  it('a command ended by a signal is never a pass; srt’s own temp folder follows CLAUDE_CODE_TMPDIR', async () => {
    const f = fakeSrt()
    const made: string[] = []
    const kid = child()
    const done = runInSrt({ payload, load: async () => f.srt, spawn: () => kid, mkdir: (d) => void made.push(d), env: { CLAUDE_CODE_TMPDIR: '/var/tmp/c' } })
    await new Promise((r) => setTimeout(r, 0))
    kid.emit('exit', null, 'SIGTERM')
    expect(await done).toBe(143)
    expect(made).toEqual(['/var/tmp/c'])
  })

  // Fix round 2 (M1): only a failure before the check ran is srt's (the runner then says so with its own exit code); once
  // the check ran, its exit code stands whatever srt's clean-up does, which the runner only reports
  it('rejects when srt cannot put the check in its sandbox, and keeps a check’s code when only the clean-up fails', async () => {
    const setup = fakeSrt({ initializeFails: 'bwrap: setting up uid map: Permission denied' })
    await expect(runInSrt({ payload, load: async () => setup.srt, spawn: () => child(), mkdir: () => {}, env: {} })).rejects.toThrow('bwrap: setting up uid map')
    const after = fakeSrt({ resetFails: 'proxy already stopped' })
    const kid = child()
    const warned: string[] = []
    const done = runInSrt({ payload, load: async () => after.srt, spawn: () => kid, mkdir: () => {}, env: {}, warn: (m) => void warned.push(m) })
    await new Promise((r) => setTimeout(r, 0))
    kid.emit('exit', 2, null)
    expect(await done).toBe(2)
    expect(warned).toEqual([expect.stringContaining('proxy already stopped')])
  })
})

// Fix round 1: srt finds the helpers it hands other programs (Linux's seccomp loader, run inside bubblewrap; the JVM's
// proxy agent jar, read by a JVM) beside its own module (dist/sandbox/generate-seccomp-filter.js:114-124,
// java-proxy-agent.js:59-64). In a packaged app that module's path is inside app.asar, which bubblewrap and a JVM cannot
// open: the files are real only under app.asar.unpacked, the folder Electron documents for unpacked files. So the runner
// names them there explicitly, as srt allows (`seccomp.applyPath`, `javaAgentJarPath`, sandbox-config.js:914, 1010-1014),
// the way node-pty points at its spawn-helper (lib/unixTerminal.js:31).
describe('srtHelpersOf', () => {
  const packed = '/opt/Astera/resources/app.asar/node_modules/@anthropic-ai/sandbox-runtime'
  const unpacked = '/opt/Astera/resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime'
  it("names srt's seccomp loader (Linux) and the JVM agent where a packaged app keeps them unpacked", () => {
    expect(srtHelpersOf(packed, 'x64', 'linux')).toEqual({
      seccomp: { applyPath: `${unpacked}/vendor/seccomp/x64/apply-seccomp` },
      javaAgentJarPath: `${unpacked}/vendor/java-proxy-agent/srt-proxy-agent.jar`
    })
    expect(srtHelpersOf(packed, 'arm64', 'linux').seccomp).toEqual({ applyPath: `${unpacked}/vendor/seccomp/arm64/apply-seccomp` })
    const mac = '/Applications/Astera.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/sandbox-runtime'
    expect(srtHelpersOf(mac, 'arm64', 'darwin')).toEqual({
      javaAgentJarPath: '/Applications/Astera.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar'
    })
  })

  it('leaves a path outside an archive, or already unpacked, as it is; names no seccomp loader srt has none for', () => {
    expect(srtHelpersOf('/src/astera/node_modules/@anthropic-ai/sandbox-runtime', 'x64', 'linux').seccomp).toEqual({
      applyPath: '/src/astera/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp'
    })
    expect(srtHelpersOf(unpacked, 'x64', 'linux').javaAgentJarPath).toBe(`${unpacked}/vendor/java-proxy-agent/srt-proxy-agent.jar`)
    expect(srtHelpersOf(packed, 'ia32', 'linux')).not.toHaveProperty('seccomp')
  })

  it('lists exactly the files it names, for the packaging check', () => {
    expect([...SRT_RUNTIME_FILES].sort()).toEqual(['vendor/java-proxy-agent/srt-proxy-agent.jar', 'vendor/seccomp/arm64/apply-seccomp', 'vendor/seccomp/x64/apply-seccomp'])
  })
})

describe('srtCheckRunner', () => {
  it('says what srt lacks here, or nothing; and that the runtime is not there when it cannot be loaded', async () => {
    expect(await srtCheckRunner({ execPath: '/a/astera', runnerPath: '/a/sandbox-check.js', load: async () => fakeSrt().srt }).missing()).toBeNull()
    const lacking = srtCheckRunner({ execPath: '/a/astera', runnerPath: '/r', load: async () => fakeSrt({ errors: ['ripgrep (rg) not found', 'socat not found'] }).srt })
    expect(await lacking.missing()).toBe('ripgrep (rg) not found; socat not found')
    const none = srtCheckRunner({ execPath: '/a/astera', runnerPath: '/r', load: async () => Promise.reject(new Error("Cannot find module '@anthropic-ai/sandbox-runtime'")) })
    expect(await none.missing()).toMatch(/sandbox runtime could not be loaded/)
  })

  it("starts the runner with Astera's own executable as node, the check in its one argument", () => {
    const p = { config: srtConfigOf(part, { cwd: '/w', layout: null }), cwd: '/w', command: 'npm test' }
    expect(srtCheckRunner({ execPath: '/a/astera', runnerPath: '/a/sandbox-check.js' }).launch(p)).toEqual({
      file: '/a/astera',
      args: ['/a/sandbox-check.js', JSON.stringify(p)],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})
