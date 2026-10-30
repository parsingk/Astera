// Enforce's verdict (enforce design §5, E7): what the Rules deny is blocked before it runs, Astera's own settings are
// out of an agent's reach whatever the rules say, and a call the hook cannot judge against readable Rules is let through
// only when it reads.
import { describe, it, expect } from 'vitest'
import { enforceVerdict, BUILT_IN_RULE_IDS } from './enforce'
import { STARTER_POLICY, type AuditPolicy } from './policy'
import type { ResolveCall } from './resolve'

const WIN_PROFILE = 'C:/Users/u/AppData/Roaming/astera'
const LINUX_PROFILE = '/home/u/.config/astera'

// A write outside the project: inside or outside is read with this machine's own path rules (resolve.ts), so the
// path is absolute here, where 'C:/elsewhere' on Linux or macOS would be a folder inside the project
const OUTSIDE = process.platform === 'win32' ? 'C:/elsewhere/x.txt' : '/elsewhere/x.txt'
const claude = (tool: string, input: Record<string, unknown>, over: Partial<ResolveCall> = {}): ResolveCall => ({ provider: 'claude', tool, input, cwd: 'D:/proj', ...over })
const WIN_ENV = { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const LINUX_ENV = { HOME: '/home/u' }
const verdict = (
  call: ResolveCall,
  policy: AuditPolicy | null = STARTER_POLICY,
  platform: NodeJS.Platform = 'win32',
  profileDir = WIN_PROFILE,
  env: Record<string, string> = platform === 'win32' ? WIN_ENV : LINUX_ENV
) => enforceVerdict({ call, policy, profileDir, platform, env })

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
    expect(verdict(claude('Write', { file_path: OUTSIDE }))).toEqual({
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

  // Final review I2: the folder named through the home, a variable, a relative path or a macOS escaped space, and an MCP
  // tool's own path argument
  it('blocks a write into the profile however the shell or the tool names it', () => {
    const open: AuditPolicy = { version: 1, mode: 'enforce', rules: [], otherwise: 'allow' }
    const blocked = (call: ResolveCall, platform: NodeJS.Platform = 'win32', profileDir = WIN_PROFILE) =>
      verdict(call, open, platform, profileDir).deny && (verdict(call, open, platform, profileDir) as { ruleId: string }).ruleId
    expect(blocked(claude('Bash', { command: 'echo x > ~/.config/astera/audit-policy.json' }), 'linux', LINUX_PROFILE)).toBe('builtin-profile-write')
    expect(blocked(claude('Bash', { command: 'cp a "$HOME/.config/astera/astera-enforce-hook.cjs"' }), 'linux', LINUX_PROFILE)).toBe('builtin-profile-write')
    expect(blocked(claude('Bash', { command: 'rm ${HOME}/.config/astera/audit-policy.json' }), 'linux', LINUX_PROFILE)).toBe('builtin-profile-write')
    expect(blocked(claude('PowerShell', { command: 'Set-Content $env:APPDATA\\astera\\audit-policy.json x' }))).toBe('builtin-profile-write')
    expect(blocked(claude('Bash', { command: 'echo > "$APPDATA/astera/audit-policy.json"' }))).toBe('builtin-profile-write')
    expect(blocked(claude('Bash', { command: 'cmd /c "echo x > %APPDATA%\\astera\\x.json"' }))).toBe('builtin-profile-write')
    expect(blocked(claude('Bash', { command: 'echo x > ../../AppData/Roaming/astera/x.json' }, { cwd: 'C:/Users/u/work/proj' }))).toBe('builtin-profile-write')
    expect(blocked({ provider: 'codex', tool: 'apply_patch', input: { command: '*** Begin Patch\n*** Add File: ../../AppData/Roaming/astera/x.json\n+x\n*** End Patch' }, cwd: 'C:/Users/u/work/proj' })).toBe(
      'builtin-profile-write'
    )
    const mac = '/Users/u/Library/Application Support/astera'
    expect(blocked(claude('Bash', { command: 'echo x > /Users/u/Library/Application\\ Support/astera/audit-policy.json' }), 'darwin', mac)).toBe('builtin-profile-write')
    expect(blocked(claude('mcp__fs__write_file', { path: 'C:/Users/u/AppData/Roaming/astera/x.json', content: 'x' }))).toBe('builtin-profile-write')
    // Elsewhere stays the person's rules'
    expect(blocked(claude('Bash', { command: 'echo x > ~/notes.txt' }), 'linux', LINUX_PROFILE)).toBe(false)
    expect(blocked(claude('Bash', { command: 'echo x > ../other/x.json' }, { cwd: 'C:/Users/u/work/proj' }))).toBe(false)
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

  // Final review C1: the spellings Astera's own guide teaches, global flags before the group, and wrappers
  it('blocks a changing astera command however the CLI is reached', () => {
    const changes = [
      `ASTERA_SESSION= "$ASTERA_CLI" policies rules-add --effect allow --action '*' --at 0`,
      `$env:ASTERA_SESSION=''; & $env:ASTERA_CLI policies set-otherwise --effect allow`,
      '& "$env:ASTERA_CLI" agent-profiles delete --id p1',
      '"${ASTERA_CLI}" policies rules-remove --id r1',
      '%ASTERA_CLI% policies set-mode --mode compatibility',
      'astera --json policies set-mode --mode observe',
      'astera --project . policies rules-reset',
      'env astera policies rules-move --id r1 --to 0',
      'command astera agent-profiles update --id p1 --bypass',
      'cmd /c astera policies set-mode --mode compatibility',
      'node "C:/Program Files/Astera/resources/app.asar/out/main/cli.js" policies set-otherwise --effect allow'
    ]
    for (const command of changes) expect(verdict(claude('Bash', { command })), command).toMatchObject({ deny: true, ruleId: 'builtin-settings-command' })
    // Reading them is not a change, and a line that only mentions the words runs no astera
    for (const command of ['"$ASTERA_CLI" policies show', 'astera --json agent-profiles list', 'astera audit list --decision blocked', 'git commit -m "policies: create the rule"'])
      expect(verdict(claude('Bash', { command })), command).toEqual({ deny: false })
  })

  // Lifecycle design §7: the findings' ignore list is the person's, so an agent cannot hide a finding about itself; reading
  // the findings is not a change
  it('blocks the findings ignore commands and lets the audit read through', () => {
    for (const command of ['astera agent-profiles audit-ignore unused-profile:ap_1 --note n', 'ASTERA_SESSION= "$ASTERA_CLI" agent-profiles audit-unignore stale-runtime:rt_1'])
      expect(verdict(claude('Bash', { command })), command).toMatchObject({ deny: true, ruleId: 'builtin-settings-command' })
    for (const command of ['astera agent-profiles audit', 'astera agent-profiles audit --all --json'])
      expect(verdict(claude('Bash', { command })), command).toEqual({ deny: false })
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
