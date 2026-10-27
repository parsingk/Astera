// Enforce's verdict (enforce design §5, E7): what the Rules deny is blocked before it runs, Astera's own settings are
// out of an agent's reach whatever the rules say, and a call the hook cannot judge against readable Rules is let through
// only when it reads.
import { describe, it, expect } from 'vitest'
import { enforceVerdict, BUILT_IN_RULE_IDS } from './enforce'
import { STARTER_POLICY, type AuditPolicy } from './policy'
import type { ResolveCall } from './resolve'

const WIN_PROFILE = 'C:/Users/u/AppData/Roaming/astera'
const LINUX_PROFILE = '/home/u/.config/astera'

const claude = (tool: string, input: Record<string, unknown>, over: Partial<ResolveCall> = {}): ResolveCall => ({ provider: 'claude', tool, input, cwd: 'D:/proj', ...over })
const verdict = (call: ResolveCall, policy: AuditPolicy | null = STARTER_POLICY, platform: NodeJS.Platform = 'win32', profileDir = WIN_PROFILE) =>
  enforceVerdict({ call, policy, profileDir, platform })

describe('enforceVerdict', () => {
  it('names its built-in rules', () => {
    expect(BUILT_IN_RULE_IDS).toEqual(['builtin-profile-write', 'builtin-settings-command'])
  })

  it('denies what the rules deny and names the rule', () => {
    expect(verdict(claude('Bash', { command: 'git push origin main' }))).toEqual({
      deny: true,
      ruleId: 'starter-git-remote-write',
      reason: 'Blocked by Astera Rules: git.remote.write is denied.'
    })
    expect(verdict(claude('Write', { file_path: 'C:/elsewhere/x.txt' }))).toEqual({
      deny: true,
      ruleId: 'starter-write-outside',
      reason: 'Blocked by Astera Rules: filesystem.write outside the project is denied.'
    })
  })

  it('allows what no rule denies', () => {
    expect(verdict(claude('Bash', { command: 'git status' }))).toEqual({ deny: false })
    expect(verdict(claude('Write', { file_path: 'D:/proj/src/a.ts' }))).toEqual({ deny: false })
  })

  it('follows otherwise for an unknown call', () => {
    const call = claude('Bash', { command: 'xargs rm' })
    expect(verdict(call)).toEqual({ deny: false })
    expect(verdict(call, { ...STARTER_POLICY, otherwise: 'deny' })).toMatchObject({ deny: true, ruleId: 'otherwise' })
    expect(verdict(claude('Bash', { command: 'npm test' }), { ...STARTER_POLICY, otherwise: 'deny' })).toEqual({
      deny: true,
      ruleId: 'otherwise',
      reason: 'Blocked by Astera Rules: no rule allows process.execute.'
    })
  })

  it('blocks a write into the profile however the path is spelled', () => {
    const profile = { deny: true, ruleId: 'builtin-profile-write', reason: "Blocked by Astera: an agent session cannot write Astera's settings folder." }
    expect(verdict(claude('Write', { file_path: 'C:\\Users\\U\\AppData\\Roaming\\Astera\\audit-policy.json' }))).toEqual(profile)
    expect(verdict(claude('PowerShell', { command: 'Set-Content C:/users/u/appdata/roaming/astera/x.json 1' }))).toEqual(profile)
    expect(verdict(claude('Bash', { command: 'cd /c/Users/u/AppData/Roaming/astera && echo x > audit-policy.json' }))).toEqual(profile)
    // The shell already there from the call before
    expect(verdict(claude('Bash', { command: 'echo x > audit-policy.json' }, { base: 'C:/Users/u/AppData/Roaming/astera/' }))).toEqual(profile)
    expect(verdict(claude('Write', { file_path: '/home/u/.config/astera/agent-profiles.json' }), STARTER_POLICY, 'linux', LINUX_PROFILE)).toEqual(profile)
    // Reading Astera's settings is not a write
    expect(verdict(claude('Read', { file_path: 'C:/Users/u/AppData/Roaming/astera/audit-policy.json' }))).toEqual({ deny: false })
    // Case counts on Linux: another folder
    expect(verdict(claude('Write', { file_path: '/home/u/.config/Astera/x.json' }), STARTER_POLICY, 'linux', LINUX_PROFILE)).toMatchObject({ deny: true, ruleId: 'starter-write-outside' })
  })

  it('blocks apply_patch into the profile', () => {
    const patch = '*** Begin Patch\n*** Update File: C:/Users/u/AppData/Roaming/astera/agent-profiles.json\n@@\n-a\n+b\n*** End Patch'
    expect(verdict({ provider: 'codex', tool: 'apply_patch', input: patch, cwd: 'D:/proj' })).toMatchObject({ deny: true, ruleId: 'builtin-profile-write' })
  })

  it('blocks astera through a path or a .cmd', () => {
    const settings = { deny: true, ruleId: 'builtin-settings-command', reason: "Blocked by Astera: an agent session cannot change Astera's Policies, Credentials or agent profiles." }
    expect(verdict(claude('Bash', { command: 'astera policies set-mode compatibility' }))).toEqual(settings)
    expect(verdict(claude('PowerShell', { command: '& "C:/Program Files/Astera/astera.cmd" policies rules-reset' }))).toEqual(settings)
    expect(verdict(claude('Bash', { command: '/usr/local/bin/astera agent-profiles delete --id x' }), STARTER_POLICY, 'linux', LINUX_PROFILE)).toEqual(settings)
    expect(verdict(claude('Bash', { command: 'git status && ASTERA_SESSION= astera policies rules-remove --id r1' }))).toEqual(settings)
    expect(verdict(claude('Bash', { command: 'astera policies show' }))).toEqual({ deny: false })
    expect(verdict(claude('Bash', { command: 'astera agent-profiles list' }))).toEqual({ deny: false })
    expect(verdict(claude('Bash', { command: 'echo asterapolicies set-mode' }))).toEqual({ deny: false })
  })

  it('fails closed to reads when the rules cannot be read', () => {
    const closed = { deny: true, ruleId: 'fail-closed', reason: 'Blocked by Astera: the Rules could not be read, so only reads are allowed.' }
    expect(verdict(claude('Read', { file_path: 'D:/proj/a.ts' }), null)).toEqual({ deny: false })
    expect(verdict(claude('TodoWrite', {}), null)).toEqual({ deny: false })
    expect(verdict(claude('Bash', { command: 'git status' }), null)).toEqual({ deny: false })
    expect(verdict(claude('Write', { file_path: 'D:/proj/a.ts' }), null)).toEqual(closed)
    expect(verdict(claude('Bash', { command: 'git push' }), null)).toEqual(closed)
    expect(verdict(claude('Bash', { command: 'cat a.txt; rm -rf b' }), null)).toEqual(closed)
  })

  it('the built-ins hold even when a rule allows everything', () => {
    const open: AuditPolicy = { version: 1, mode: 'enforce', rules: [{ id: 'all', effect: 'allow', action: '*' }], otherwise: 'allow' }
    expect(verdict(claude('Write', { file_path: 'C:/Users/u/AppData/Roaming/astera/x.json' }), open)).toMatchObject({ ruleId: 'builtin-profile-write' })
    expect(verdict(claude('Bash', { command: 'astera policies set-mode observe' }), open)).toMatchObject({ ruleId: 'builtin-settings-command' })
  })
})
