// A Claude Job's checks on macOS and Linux run under the runtime Claude Code builds its sandbox on (Task K, the person's
// Q2): @anthropic-ai/sandbox-runtime 0.0.79 in library mode, through Astera's own small runner, with the settings a
// session's twin holds. No srt runs here: the module, the spawn and the folder are fakes.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { claudeSandboxSettings } from './claudeSettings'
import type { GitLayout } from './gitLayout'
import { runInSrt, srtCheckRunner, srtConfigOf, type SrtModule } from './srtCheck'

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
function fakeSrt(o: { errors?: string[] } = {}) {
  const calls: Array<{ op: string; arg?: unknown }> = []
  let ask: ((p: { host: string; port: number }) => Promise<boolean>) | undefined
  const srt: SrtModule = {
    SandboxManager: {
      initialize: async (config, cb) => void (calls.push({ op: 'initialize', arg: config }), (ask = cb)),
      wrapWithSandbox: async (command) => (calls.push({ op: 'wrap', arg: command }), `wrapped:${command}`),
      cleanupAfterCommand: () => void calls.push({ op: 'cleanup' }),
      reset: async () => void calls.push({ op: 'reset' }),
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
