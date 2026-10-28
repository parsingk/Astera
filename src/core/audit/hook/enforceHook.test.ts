// Enforce's hook (enforce design §5): it prints the deny itself, because both CLIs let a call through when a hook crashes
// or times out; it reads the Rules as the file holds them at that moment, and leaves the proof that it ran beside them.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { runEnforceHook, ENFORCE_RETRIES } from './enforceHook'
import { STARTER_POLICY } from '../policy'

const PROFILE = 'C:/p/astera'
// The session's folders as this machine writes them: inside or outside the project is read with its own path rules
// (resolve.ts), and 'D:/proj' is no absolute path on Linux or macOS
const at = (p: string): string => (process.platform === 'win32' ? p : p.slice(2))
const payload = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: 'native', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', cwd: at('D:/proj'), ...extra })

function run(stdin: string, over: Partial<Parameters<typeof runEnforceHook>[0]> = {}) {
  const lines: Array<[string, string]> = []
  const sleeps: number[] = []
  const out = runEnforceHook({
    stdin,
    provider: 'claude',
    profileDir: PROFILE,
    sessionId: 's1',
    platform: 'win32',
    now: () => 1000,
    readRules: () => JSON.stringify(STARTER_POLICY),
    append: (file, line) => void lines.push([file, line]),
    sleep: (ms) => void sleeps.push(ms),
    ...over
  })
  return { out, lines, sleeps }
}

const deny = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

describe('runEnforceHook', () => {
  it('prints the deny JSON for a denied call and nothing for an allowed one', () => {
    expect(run(payload('Bash', { command: 'git push origin main' })).out).toBe(deny('Blocked by Astera Rules: git.remote.write is denied.'))
    expect(run(payload('Bash', { command: 'git status' })).out).toBe('')
  })

  it('writes the proof and the blocked call to the session’s enforce file', () => {
    const file = path.join(PROFILE, 'enforce', 's1.jsonl')
    // Whose CLI, so the Host files it under that CLI's hook; a stopped call as the hook resolved it, which the Host keeps
    // as it is (host/audit/sources.ts enforceBlockedCall)
    expect(run(payload('Bash', { command: 'git status' })).lines).toEqual([[file, '{"at":1000,"provider":"claude","tool":"Bash","id":"toolu_1"}\n']])
    expect(run(payload('Bash', { command: 'git push origin main' })).lines).toEqual([
      [file, '{"at":1000,"provider":"claude","tool":"Bash","id":"toolu_1","blocked":"starter-git-remote-write","action":"git.remote.write","target":"git push","confidence":"high"}\n']
    ])
    expect(JSON.parse(run(payload('Write', { file_path: at('D:/elsewhere/x.txt'), content: 'x' })).lines[0][1])).toMatchObject({
      blocked: 'starter-write-outside', action: 'filesystem.write', insideProject: false, confidence: 'exact'
    })
    // No session: nothing to write, the decision still stands
    expect(run(payload('Bash', { command: 'git push' }), { sessionId: undefined })).toMatchObject({ lines: [], out: deny('Blocked by Astera Rules: git.remote.write is denied.') })
    // A write that fails does not change the decision
    expect(run(payload('Bash', { command: 'git push' }), { append: () => { throw new Error('EACCES') } }).out).toBe(deny('Blocked by Astera Rules: git.remote.write is denied.'))
  })

  it('retries a busy rules file before failing closed', () => {
    expect(ENFORCE_RETRIES).toBe(3)
    let throws = 2
    const busy = (): string => {
      if (throws-- > 0) throw new Error('EPERM')
      return JSON.stringify(STARTER_POLICY)
    }
    const write = payload('Write', { file_path: at('D:/proj/src/a.ts') })
    expect(run(write, { readRules: busy })).toMatchObject({ out: '', sleeps: [20, 20] })
    const never = (): string => {
      throw new Error('EPERM')
    }
    expect(run(write, { readRules: never })).toMatchObject({
      out: deny('Blocked by Astera: the Rules could not be read, so only reads are allowed.'),
      sleeps: [20, 20, 20]
    })
    // A file that holds no policy is unreadable too, at once
    expect(run(write, { readRules: () => '{ broken' })).toMatchObject({ out: deny('Blocked by Astera: the Rules could not be read, so only reads are allowed.'), sleeps: [] })
  })

  it('denies a payload it cannot read', () => {
    const unreadable = deny('Blocked by Astera: this call could not be read, so it was not allowed.')
    for (const stdin of ['', 'nope', '{"tool_input":{}}', '[1]']) expect(run(stdin).out, stdin).toBe(unreadable)
  })

  // Final review I1: Claude's hook cwd follows a `cd`; the project is where the session started (CLAUDE_PROJECT_DIR)
  it('measures inside the project from the session folder, not from where a cd left the shell', () => {
    const write = (projectDir: string | undefined) =>
      run(payload('Write', { file_path: at('D:/proj/README.md'), content: 'x' }, { cwd: at('D:/proj/packages/app') }), projectDir === undefined ? {} : { projectDir }).out
    expect(write(at('D:/proj'))).toBe('')
    // Without it, the payload's own cwd is all there is
    expect(write(undefined)).toBe(deny('Blocked by Astera Rules: filesystem.write outside the project is denied.'))
  })

  it('uses the starter rules when there is no rules file', () => {
    expect(run(payload('Bash', { command: 'git push' }), { readRules: () => null }).out).toBe(deny('Blocked by Astera Rules: git.remote.write is denied.'))
  })

  // The payload a Codex 0.160 hook got (measured 2026-10-27): its shell is `Bash`, a patch is apply_patch
  it('reads a Codex call as Codex', () => {
    const codex = (tool: string, input: unknown): string =>
      run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: at('D:/proj'), tool_use_id: 'exec-1' }), { provider: 'codex' }).out
    expect(codex('Bash', { command: 'git push origin main' })).toBe(deny('Blocked by Astera Rules: git.remote.write is denied.'))
    expect(codex('apply_patch', { command: '*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch' })).toBe(
      deny('Blocked by Astera Rules: filesystem.write outside the project is denied.')
    )
    expect(codex('apply_patch', { command: '*** Begin Patch\n*** Add File: inside.txt\n+x\n*** End Patch' })).toBe('')
  })
})
