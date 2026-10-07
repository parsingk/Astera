import { describe, it, expect } from 'vitest'
import { buildClaudeCommand, buildCodexCommand, buildCodexAppServerCommand, buildClaudeChatCommand } from './commands'
import { claudeLaunchArgs } from '../chat/claudeProtocol'

/** Where the npm shims live on a test machine: the win32 builders spawn a CLI by where PATH says it
 *  is, never by name (windowsExecutable.ts), so a test says where that is. */
const SHIMS: Record<string, string> = {
  claude: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  codex: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'
}
const shim = (name: string): string | null => SHIMS[name] ?? null
/** What every codex command opens with (the update check off; see `codex update check` below). */
const NO_UPDATE = ['-c', 'check_for_update_on_startup=false']

describe('initialPrompt', () => {
  it('claude: 마지막 위치 인자로 싣는다', () => {
    const { file, args } = buildClaudeCommand('linux')({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(file).toBe('claude')
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('codex: 마지막 위치 인자로 싣는다', () => {
    const { args } = buildCodexCommand('linux')({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('win32에서도 cmd.exe 래핑의 마지막에 온다', () => {
    const { file, args } = buildClaudeCommand('win32', shim)({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(file).toBe('cmd.exe')
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('initialPrompt는 sanitize하지 않는다 — 경로가 깨지면 안 된다', () => {
    const p = 'C:/u/orch/specs/tsk_1-dsp_1.md 를 읽고 그 지시를 따르라'
    expect(buildCodexCommand('win32', shim)({ initialPrompt: p }).args.at(-1)).toBe(p)
  })
  it('resumeSessionId와 함께 오면 resume 인자 뒤에 온다', () => {
    const { args } = buildCodexCommand('linux')({
      resumeSessionId: 'sid',
      initialPrompt: 'do it'
    })
    expect(args.indexOf('resume')).toBeLessThan(args.indexOf('do it'))
  })
  it('없으면 인자가 늘지 않는다', () => {
    expect(buildClaudeCommand('linux')({}).args).toEqual([])
  })
})

describe('claude --add-dir', () => {
  it('grants read access to the given directories, variadically', () => {
    const { args } = buildClaudeCommand('linux')({ addDirs: ['/data/shots'] })
    expect(args.slice(0, 2)).toEqual(['--add-dir', '/data/shots'])
  })
  // The variadic option eats every positional that follows it, and the prompt is a positional. A
  // session whose prompt was eaten comes up at an empty REPL and never runs its turn — that is a
  // coordinator that never dispatches a Task, and a worker that never reads its spec.
  it('cannot swallow the prompt — `--` fences it off', () => {
    const { args } = buildClaudeCommand('linux')({ addDirs: ['/data/shots'], initialPrompt: 'fix it' })
    expect(args).toEqual(['--add-dir', '/data/shots', '--', 'fix it'])
  })
  it('emits nothing when there are no directories', () => {
    expect(buildClaudeCommand('linux')({}).args).toEqual([])
    expect(buildClaudeCommand('linux')({ addDirs: [] }).args).toEqual([])
  })
  it('carries a win32 path through the cmd.exe wrapper', () => {
    const { file, args } = buildClaudeCommand('win32', shim)({ addDirs: ['C:\Users\me\AppData\Roaming\astera-dev\preview\shots'] })
    expect(file).toBe('cmd.exe')
    expect(args).toContain('C:\Users\me\AppData\Roaming\astera-dev\preview\shots')
  })
  it('codex ignores addDirs — it reads those paths without a prompt', () => {
    expect(buildCodexCommand('linux')({ addDirs: ['/data/shots'] }).args).not.toContain('--add-dir')
  })
})

// A codex TUI with an update out opens on "Update available … 1. Update now 2. Skip", and a worker
// nobody sits in front of stops there (measured 2026-10-07, 0.160.0 with 0.160.1 out).
describe('codex update check', () => {
  it('is off for every codex session Astera starts', () => {
    expect(buildCodexCommand('linux')({}).args).toEqual(NO_UPDATE)
  })
  // Ahead of the subcommand, where codex's root options apply to `resume` too (measured: the update menu
  // without it, the session picker with it), and out of the way of the prompt, which stays last.
  it('comes before resume, and the prompts stay last', () => {
    expect(buildCodexCommand('linux')({ resumeSessionId: 'sid', resumePrompt: 'go on' }).args).toEqual([...NO_UPDATE, 'resume', 'sid', 'go on'])
    expect(buildCodexCommand('linux')({ bypassPermissions: true, initialPrompt: 'do it' }).args.at(-1)).toBe('do it')
  })
})

// A codex 0.160 TUI attached to the shared app-server daemon runs its shell in the daemon's environment,
// not its own (codexNoDaemon.ts). The builder asks whether this codex knows `--no-daemon`.
describe('codex --no-daemon', () => {
  it('runs its own server when the binary knows the flag', () => {
    expect(buildCodexCommand('linux', undefined, () => true)({}).args).toEqual([...NO_UPDATE, '--no-daemon'])
  })
  it('keeps the flag on a resume, after the resume arguments', () => {
    const { args } = buildCodexCommand('linux', undefined, () => true)({ resumeSessionId: 'sid', resumePrompt: 'go on' })
    expect(args).toEqual([...NO_UPDATE, 'resume', 'sid', 'go on', '--no-daemon'])
  })
  it('leaves the prompt last', () => {
    const { args } = buildCodexCommand('linux', undefined, () => true)({ bypassPermissions: true, initialPrompt: 'do it' })
    expect(args).toEqual([...NO_UPDATE, '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', 'do it'])
  })
  it('goes inside the cmd.exe wrapper on win32', () => {
    expect(buildCodexCommand('win32', shim, () => true)({}).args).toEqual(['/d', '/c', 'call', SHIMS.codex, ...NO_UPDATE, '--no-daemon'])
  })
  it('is left out for a binary that does not know it, and by default', () => {
    expect(buildCodexCommand('linux', undefined, () => false)({}).args).toEqual(NO_UPDATE)
    expect(buildCodexCommand('linux')({}).args).toEqual(NO_UPDATE)
  })
})

describe('buildCodexAppServerCommand', () => {
  it('wraps through cmd.exe on win32, by the shim’s absolute path', () => {
    expect(buildCodexAppServerCommand('win32', shim)).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', 'call', SHIMS.codex, 'app-server']
    })
  })
  it('runs codex directly elsewhere', () => {
    expect(buildCodexAppServerCommand('linux')).toEqual({ file: 'codex', args: ['app-server'] })
  })
})

describe('buildClaudeChatCommand', () => {
  it('wraps through cmd.exe on win32, claude first', () => {
    const { file, args } = buildClaudeChatCommand('win32', { bypass: false }, shim)
    expect(file).toBe('cmd.exe')
    expect(args.slice(0, 4)).toEqual(['/d', '/c', 'call', SHIMS.claude])
    expect(args.slice(4)).toEqual(claudeLaunchArgs({ bypass: false }))
  })
  it('runs claude directly elsewhere', () => {
    const { file, args } = buildClaudeChatCommand('linux', { bypass: false })
    expect(file).toBe('claude')
    expect(args).toEqual(claudeLaunchArgs({ bypass: false }))
  })
  it('carries resume, bypass and model through claudeLaunchArgs, in that order', () => {
    const { args } = buildClaudeChatCommand('linux', { resumeSessionId: 'th-1', bypass: true, model: 'opus' })
    expect(args).toEqual(claudeLaunchArgs({ resumeSessionId: 'th-1', bypass: true, model: 'opus' }))
    expect(args.indexOf('--resume=th-1')).toBeLessThan(args.indexOf('--permission-mode'))
    expect(args.indexOf('--permission-mode')).toBeLessThan(args.indexOf('--model'))
  })
})

// Security review 2026-09-28 (CWE-427): cmd.exe looks a bare name up in the working directory before
// PATH, and the working directory is the project. A CLI is therefore never named to cmd.exe: a .cmd
// shim goes by its absolute path, a native .exe is spawned with no shell at all, and a CLI that PATH
// does not know is spawned bare rather than handed to cmd.exe — the repository's folder is never it.
describe('win32 never hands a bare CLI name to cmd.exe', () => {
  it('a .cmd shim is called by its absolute path', () => {
    expect(buildClaudeCommand('win32', shim)({}).args.slice(0, 4)).toEqual(['/d', '/c', 'call', SHIMS.claude])
  })
  it('a native .exe is spawned directly', () => {
    const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    expect(buildClaudeCommand('win32', () => exe)({ initialPrompt: 'hi' })).toEqual({ file: exe, args: ['--', 'hi'] })
    expect(buildClaudeChatCommand('win32', { bypass: true }, () => exe).file).toBe(exe)
  })
  it('a CLI PATH does not know is not looked up by cmd.exe', () => {
    for (const cmd of [
      buildClaudeCommand('win32', () => null)({}),
      buildCodexCommand('win32', () => null)({}),
      buildCodexAppServerCommand('win32', () => null),
      buildClaudeChatCommand('win32', { bypass: false }, () => null)
    ])
      expect(cmd.file).not.toBe('cmd.exe')
  })
})
