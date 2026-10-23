// Observe mode's rules (design §7, ruling M1): one ordered list and the mode, kept in `<profile>/audit-policy.json` with
// the extension registry's store pattern, and the evaluator that previews what the rules would have done with a call.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { RepairNeeded } from '../settings/repairNeeded'
import { resolveAction, type AuditAction } from './resolve'
import {
  AUDIT_ACTIONS,
  COVERAGE,
  STARTER_POLICY,
  decide,
  isRuleAction,
  readAuditPolicy,
  readPolicyMode,
  writeAuditPolicy,
  type AuditPolicy,
  type AuditRule
} from './policy'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditpolicy-'))
  dirs.push(d)
  return d
}

const starterId = (action: string): string => STARTER_POLICY.rules.find((r) => r.action === action)!.id
const policy = (rules: Array<Omit<AuditRule, 'id'>>, otherwise: 'allow' | 'deny' = 'allow'): AuditPolicy => ({
  version: 1,
  mode: 'observe',
  rules: rules.map((r, i) => ({ id: `r${i}`, ...r })),
  otherwise
})

const cwd = path.resolve('/work/proj')
const bash = (command: string) => resolveAction({ provider: 'claude', tool: 'Bash', input: { command }, cwd })
const claude = (tool: string, input: unknown) => resolveAction({ provider: 'claude', tool, input, cwd })

describe('STARTER_POLICY', () => {
  it('denies pushes, pull requests, GitHub writes and writes or deletes outside the project, and allows the rest', () => {
    expect(STARTER_POLICY.version).toBe(1)
    expect(STARTER_POLICY.mode).toBe('compatibility')
    expect(STARTER_POLICY.otherwise).toBe('allow')
    expect(STARTER_POLICY.rules.map(({ effect, action, scope }) => ({ effect, action, scope }))).toEqual([
      { effect: 'deny', action: 'git.remote.write', scope: undefined },
      { effect: 'deny', action: 'github.pr.create', scope: undefined },
      { effect: 'deny', action: 'github.write', scope: undefined },
      { effect: 'deny', action: 'filesystem.write', scope: 'outside-project' },
      { effect: 'deny', action: 'filesystem.delete', scope: 'outside-project' }
    ])
    expect(new Set(STARTER_POLICY.rules.map((r) => r.id)).size).toBe(STARTER_POLICY.rules.length)
  })
})

describe('decide, under the starter rules', () => {
  const p = { ...STARTER_POLICY, mode: 'observe' as const }

  it('would deny a git push, naming the rule', () => {
    expect(decide(bash('git push origin main'), p)).toEqual({ decision: 'would-deny', ruleId: starterId('git.remote.write') })
  })

  it('would deny a write outside the project, and allows one inside', () => {
    expect(decide(claude('Write', { file_path: path.resolve(cwd, '..', 'x.ts') }), p)).toEqual({
      decision: 'would-deny',
      ruleId: starterId('filesystem.write')
    })
    expect(decide(claude('Write', { file_path: path.join(cwd, 'src', 'a.ts') }), p)).toEqual({ decision: 'allow' })
  })

  it('allows a read, inside or outside', () => {
    expect(decide(claude('Read', { file_path: path.join(cwd, 'a.ts') }), p)).toEqual({ decision: 'allow' })
    expect(decide(claude('Read', { file_path: path.resolve(cwd, '..', 'notes.md') }), p)).toEqual({ decision: 'allow' })
  })

  it('cannot tell a call whose confidence is unknown while no rule denies any of it', () => {
    expect(decide(bash('foo-bar.sh'), p)).toEqual({ decision: 'unknown' })
    expect(decide({ action: 'filesystem.read', insideProject: true, confidence: 'unknown' }, p)).toEqual({ decision: 'unknown' })
  })

  // Final review I1: agents push in compound lines. A line whose every command was classified is would-deny as soon as
  // one of them would be, with that command's rule (design §7, revised)
  it('would deny a compound line one of whose classified commands a rule denies, naming that rule', () => {
    const ps = (command: string) => claude('PowerShell', { command })
    const cases: Array<[ReturnType<typeof bash>, string]> = [
      [bash('cd ../other && rm -rf build'), 'filesystem.delete'],
      [bash('cd sub && git push'), 'git.remote.write'],
      [bash('git add -A && git commit -m x && git push'), 'git.remote.write'],
      [ps('git push origin main 2>&1 | Out-String'), 'git.remote.write'],
      [bash('rm -rf ../other && echo ok'), 'filesystem.delete'],
      // The redirect into a file outside the project is its own command with its own place
      [bash('npm test > /tmp/out.txt 2>&1'), 'filesystem.write'],
      [bash('npm test > ../out.log'), 'filesystem.write'],
      [bash('npm test && git push'), 'git.remote.write'],
      // The first command a rule denies decides
      [bash('git push && rm -rf ../x'), 'git.remote.write'],
      // Codex hands every command to a shell's -c, whose script is read like a typed line
      [resolveAction({ provider: 'codex', tool: 'shell', input: { command: ['bash', '-lc', 'git add -A && git push'] }, cwd }), 'git.remote.write']
    ]
    for (const [r, action] of cases) {
      expect(r.confidence, r.target).toBe('heuristic')
      expect(decide(r, p), r.target).toEqual({ decision: 'would-deny', ruleId: starterId(action) })
    }
  })

  // The person's ruling D2 (2026-10-24): a denied command is denied wherever in the line it sits. A loop or a conditional
  // that might not have run it, a script file or an unknown command beside it, change nothing: the preview errs toward flagging
  it('would deny a line with a denied command anywhere in it: in control flow, a script of several calls, or beside what it cannot read', () => {
    const push = { decision: 'would-deny', ruleId: starterId('git.remote.write') }
    // Control flow: the command may have run any number of times, or not at all
    expect(decide(bash('for b in a c; do git push origin $b; done'), p)).toEqual(push)
    expect(decide(bash('if git diff --quiet; then git push; fi'), p)).toEqual(push)
    expect(decide(bash('while true; do git push; done'), p)).toEqual(push)
    expect(decide(claude('PowerShell', { command: 'foreach ($r in $remotes) { git push $r }' }), p)).toEqual(push)
    expect(decide(claude('PowerShell', { command: 'git branch | ForEach-Object { git push origin $_ }' }), p)).toEqual(push)
    expect(decide(claude('PowerShell', { command: '1..3 | Where-Object { git push }' }), p)).toEqual(push)
    // A Codex exec script of several calls
    const exec = 'await tools.exec_command({cmd:"git add -A"});\nawait tools.exec_command({cmd:"git push"});'
    expect(decide(resolveAction({ provider: 'codex', tool: 'exec', input: exec, cwd }), p)).toEqual(push)
    // An unknown command or script in the line
    expect(decide(bash('./deploy.sh && git push'), p)).toEqual(push)
    expect(decide(bash('eval "$CMD" && git push'), p)).toEqual(push)
    // A delete that names no place, which an outside rule could match, before the denied command or after it
    expect(decide(bash('git push && rm'), p)).toEqual(push)
    expect(decide(bash('rm && git push'), p)).toEqual(push)
  })

  // A command another command runs is a command of the line (find -exec, xargs, watch, trap, backticks), so it is judged
  it('would deny a command hidden behind find -exec, xargs, watch, trap or backticks', () => {
    const cases: Array<[string, string]> = [
      ["find . -name '*.log' -exec rm -rf ../x {} \\;", 'filesystem.delete'],
      ['ls | xargs rm -rf ../x', 'filesystem.delete'],
      ['echo `git push`', 'git.remote.write'],
      ['xargs -0 -n 1 git push', 'git.remote.write'],
      ['watch -n 5 git push', 'git.remote.write'],
      ["trap 'git push' EXIT", 'git.remote.write'],
      ['find . -execdir git push \\;', 'git.remote.write']
    ]
    for (const [line, action] of cases) expect(decide(bash(line), p), line).toEqual({ decision: 'would-deny', ruleId: starterId(action) })
    // What they run inside the project is allowed as it is on its own
    expect(decide(bash('find . -name "*.log" -exec rm {} \\;'), p)).toEqual({ decision: 'allow' })
    expect(decide(bash('echo `git rev-parse HEAD`'), p)).toEqual({ decision: 'allow' })
  })

  // The shell runs a substitution inside double quotes, and not one inside single quotes
  it('would deny a command substituted inside double quotes, and allows the same text in single quotes', () => {
    const push = { decision: 'would-deny', ruleId: starterId('git.remote.write') }
    expect(decide(bash('echo "$(git push)"'), p)).toEqual(push)
    expect(decide(bash('echo "`git push`"'), p)).toEqual(push)
    expect(decide(bash('echo "$(rm -rf ../x)"'), p)).toEqual({ decision: 'would-deny', ruleId: starterId('filesystem.delete') })
    expect(decide(bash("echo '$(git push)'"), p)).toEqual({ decision: 'allow' })
    expect(decide(bash('echo "$(git rev-parse HEAD)"'), p)).toEqual({ decision: 'allow' })
  })

  it('would deny a line cut short whose kept commands include a denied one', () => {
    const cut = { action: 'process.execute' as const, confidence: 'unknown' as const, commands: [{ action: 'process.execute' as const }, { action: 'git.remote.write' as const }] }
    expect(decide(cut, p)).toEqual({ decision: 'would-deny', ruleId: starterId('git.remote.write') })
  })

  it('still cannot tell a line with an unknown command or script and no denied command, or a write that names no place', () => {
    expect(decide(bash('./deploy.sh'), p)).toEqual({ decision: 'unknown' })
    expect(decide(bash('./deploy.sh && npm test'), p)).toEqual({ decision: 'unknown' })
    expect(decide(bash('eval "$CMD"'), p)).toEqual({ decision: 'unknown' })
    expect(decide(bash('rm'), p)).toEqual({ decision: 'unknown' })
    expect(decide(bash('git status && rm'), p)).toEqual({ decision: 'unknown' })
  })

  it('allows a line with control flow whose commands no rule denies', () => {
    expect(decide(bash('for f in a b; do npm test; done'), p)).toEqual({ decision: 'allow' })
  })

  it('would deny what otherwise denies, a line it cannot read too: the enforcer would refuse it', () => {
    expect(decide(bash('./deploy.sh'), policy([], 'deny'))).toEqual({ decision: 'would-deny' })
    // A tool the resolver does not know at all is unknown under the starter rules and, with no rule for it, would-deny here
    expect(decide(claude('SomeNewTool', {}), p)).toEqual({ decision: 'unknown' })
    expect(decide(claude('SomeNewTool', {}), policy([], 'deny'))).toEqual({ decision: 'would-deny' })
  })

  it('judges each command of a compound line in its own place, so a delete inside and a read outside are allowed', () => {
    expect(decide(bash('rm -rf build && cat ../notes'), p)).toEqual({ decision: 'allow' })
    expect(decide(bash('cd src && npm test'), p)).toEqual({ decision: 'allow' })
  })

  it('never allows a write or a delete that names no place while an outside rule could match it', () => {
    const r = bash('rm')
    expect(r).toMatchObject({ action: 'filesystem.delete', confidence: 'high' })
    expect(r.insideProject).toBeUndefined()
    expect(decide(r, p)).toEqual({ decision: 'unknown' })
    expect(decide({ action: 'process.execute', confidence: 'heuristic', commands: [{ action: 'process.execute' }, { action: 'filesystem.write' }] }, p))
      .toEqual({ decision: 'unknown' })
  })

  it('judges every command even when the line is sure of itself', () => {
    expect(decide({ action: 'process.execute', confidence: 'high', commands: [{ action: 'filesystem.write', insideProject: false }] }, p)).toEqual({
      decision: 'would-deny',
      ruleId: starterId('filesystem.write')
    })
  })
})

describe('decide, by the rules a person writes', () => {
  it('lets the first matching rule decide', () => {
    const p = policy([
      { effect: 'allow', action: 'git.remote.write' },
      { effect: 'deny', action: 'git.*' }
    ])
    expect(decide({ action: 'git.remote.write', confidence: 'high' }, p)).toEqual({ decision: 'allow', ruleId: 'r0' })
    expect(decide({ action: 'git.read', confidence: 'high' }, p)).toEqual({ decision: 'would-deny', ruleId: 'r1' })
  })

  it('matches a trailing * as a prefix, and only there', () => {
    const p = policy([{ effect: 'deny', action: 'github.*' }])
    expect(decide({ action: 'github.pr.create', confidence: 'high' }, p)).toEqual({ decision: 'would-deny', ruleId: 'r0' })
    expect(decide({ action: 'github.write', confidence: 'high' }, p)).toEqual({ decision: 'would-deny', ruleId: 'r0' })
    expect(decide({ action: 'git.remote.write', confidence: 'high' }, p)).toEqual({ decision: 'allow' })
    expect(decide({ action: 'mcp.call', confidence: 'exact' }, policy([{ effect: 'deny', action: '*' }]))).toEqual({ decision: 'would-deny', ruleId: 'r0' })
  })

  it('falls to otherwise when no rule matches', () => {
    expect(decide({ action: 'network.request', confidence: 'exact' }, policy([], 'deny'))).toEqual({ decision: 'would-deny' })
    expect(decide({ action: 'network.request', confidence: 'exact' }, policy([], 'allow'))).toEqual({ decision: 'allow' })
    // A compound line of classified commands is denied by otherwise too, naming no rule
    expect(decide(bash('npm test && npm run build'), policy([], 'deny'))).toEqual({ decision: 'would-deny' })
  })

  it('matches a scope by the place, and never matches a call with no place by its scope', () => {
    const p = policy([{ effect: 'deny', action: 'filesystem.read', scope: 'inside-project' }])
    expect(decide({ action: 'filesystem.read', insideProject: true, confidence: 'exact' }, p)).toEqual({ decision: 'would-deny', ruleId: 'r0' })
    expect(decide({ action: 'filesystem.read', insideProject: false, confidence: 'exact' }, p)).toEqual({ decision: 'allow' })
    const exec = policy([{ effect: 'deny', action: 'process.execute', scope: 'outside-project' }])
    expect(decide({ action: 'process.execute', confidence: 'high' }, exec)).toEqual({ decision: 'allow' })
  })

  it('judges a write with no place both ways: sure when both places get the same decision, unknown when they differ', () => {
    const write = { action: 'filesystem.write' as const, confidence: 'high' as const }
    expect(decide(write, policy([]))).toEqual({ decision: 'allow' })
    expect(decide(write, policy([{ effect: 'deny', action: 'filesystem.*' }]))).toEqual({ decision: 'would-deny', ruleId: 'r0' })
    // The same decision from different rules names no rule
    expect(decide(write, policy([{ effect: 'deny', action: 'filesystem.write', scope: 'outside-project' }], 'deny'))).toEqual({ decision: 'would-deny' })
    expect(decide(write, policy([{ effect: 'allow', action: 'filesystem.write', scope: 'inside-project' }]))).toEqual({ decision: 'allow' })
    // Different decisions cannot be told
    expect(decide(write, policy([{ effect: 'deny', action: 'filesystem.write', scope: 'inside-project' }]))).toEqual({ decision: 'unknown' })
    expect(decide(write, policy([{ effect: 'allow', action: 'filesystem.write', scope: 'inside-project' }, { effect: 'deny', action: 'filesystem.write' }])))
      .toEqual({ decision: 'unknown' })
  })
})

describe('isRuleAction', () => {
  it('takes an action the resolver names, or a prefix of one ending in *', () => {
    for (const a of ['git.remote.write', 'filesystem.read', 'other', 'git.*', 'github.*', 'filesystem.*', '*']) expect(isRuleAction(a)).toBe(true)
    for (const a of ['', 'git.remote', 'push', 'foo.*', 'git.*.write', '**', 'git.remote.write ']) expect(isRuleAction(a)).toBe(false)
  })

  it('lists every action of the resolver once', () => {
    const all: AuditAction[] = [
      'process.execute', 'git.read', 'git.local.write', 'git.remote.write', 'github.pr.create', 'github.write', 'package.install',
      'filesystem.read', 'filesystem.write', 'filesystem.delete', 'network.request', 'mcp.call', 'agent.spawn', 'other'
    ]
    expect([...AUDIT_ACTIONS].sort()).toEqual([...all].sort())
  })
})

describe('the policy file', () => {
  it('reads a missing file as null', async () => {
    expect(await readAuditPolicy(await profile())).toBeNull()
  })

  it('round trips as audit-policy.json under the profile', async () => {
    const p = await profile()
    const written: AuditPolicy = {
      version: 1,
      mode: 'observe',
      rules: [...STARTER_POLICY.rules, { id: 'ar_000000000001', effect: 'allow', action: 'git.*', scope: 'inside-project' }],
      otherwise: 'deny'
    }
    await writeAuditPolicy(p, written)
    expect(await readAuditPolicy(p)).toEqual(written)
    expect(profilePaths(p).auditPolicy).toBe(path.join(p, 'audit-policy.json'))
  })

  it('keeps a damaged file aside, once per damage, and reports it instead of reading no rules', async () => {
    const p = await profile()
    const file = profilePaths(p).auditPolicy
    const kept = async (): Promise<string[]> => (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))
    await fs.writeFile(file, '{ not json')
    for (let i = 0; i < 3; i++) await expect(readAuditPolicy(p)).rejects.toBeInstanceOf(RepairNeeded)
    expect(await kept()).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json')
    // A rule that is not one is damage too
    await fs.writeFile(file, JSON.stringify({ ...STARTER_POLICY, rules: [{ id: 'x', effect: 'maybe', action: 'git.*' }] }))
    await expect(readAuditPolicy(p)).rejects.toBeInstanceOf(RepairNeeded)
    await fs.writeFile(file, JSON.stringify({ ...STARTER_POLICY, otherwise: 'sometimes' }))
    await expect(readAuditPolicy(p)).rejects.toBeInstanceOf(RepairNeeded)
    expect(await kept()).toHaveLength(3)
  })

  it('reads a mode it does not know as compatibility, which never observes more', async () => {
    const p = await profile()
    await fs.writeFile(profilePaths(p).auditPolicy, JSON.stringify({ ...STARTER_POLICY, mode: 'enforce' }))
    expect((await readAuditPolicy(p))?.mode).toBe('compatibility')
  })
})

describe('readPolicyMode', () => {
  it('is compatibility with no file, the file’s mode otherwise, and compatibility when the file is damaged', async () => {
    const p = await profile()
    expect(await readPolicyMode(p)).toBe('compatibility')
    await writeAuditPolicy(p, { ...STARTER_POLICY, mode: 'observe' })
    expect(await readPolicyMode(p)).toBe('observe')
    await fs.writeFile(profilePaths(p).auditPolicy, '{ not json')
    expect(await readPolicyMode(p)).toBe('compatibility')
  })

  // Final review M9: every spawn reads the mode, in the app's process as well as the Host's; a copy of the damage is
  // kept by the Host's policies commands, which the person repairs it with, not by each process that spawns
  it('keeps no copy of a damaged file, which reading the rules still does', async () => {
    const p = await profile()
    const bak = async (): Promise<string[]> => (await fs.readdir(p)).filter((f) => f.endsWith('.bak'))
    await fs.writeFile(profilePaths(p).auditPolicy, '{ "mode": "observe", damaged')
    expect(await readPolicyMode(p)).toBe('compatibility')
    expect(await bak()).toEqual([])
    await expect(readAuditPolicy(p, { keepDamaged: false })).rejects.toBeInstanceOf(RepairNeeded)
    expect(await bak()).toEqual([])
    await expect(readAuditPolicy(p)).rejects.toBeInstanceOf(RepairNeeded)
    expect(await bak()).toHaveLength(1)
  })

  it('does not read the app settings key it replaced', async () => {
    const p = await profile()
    await fs.writeFile(path.join(p, 'app-settings.json'), JSON.stringify({ controlPlanePolicyMode: 'observe' }))
    expect(await readPolicyMode(p)).toBe('compatibility')
  })
})

describe('COVERAGE', () => {
  const cell = (provider: string, kind: string, c: string) =>
    (COVERAGE.find((r) => r.provider === provider && r.kind === kind)!.classes as Record<string, unknown>)[c]

  it('has a row per provider and session kind, each with every class', () => {
    expect(COVERAGE.map((r) => `${r.provider} ${r.kind}`)).toEqual(['claude terminal', 'claude chat', 'codex terminal', 'codex chat'])
    for (const r of COVERAGE) expect(Object.keys(r.classes).sort()).toEqual(['file-read', 'file-write', 'mcp', 'network', 'shell'])
  })

  it('says what design §9 says', () => {
    for (const [p, k] of [['claude', 'terminal'], ['claude', 'chat'], ['codex', 'terminal'], ['codex', 'chat']])
      for (const c of ['shell', 'file-write', 'mcp']) expect(cell(p, k, c)).toEqual({ level: 'seen' })
    expect(cell('claude', 'terminal', 'file-read')).toEqual({ level: 'seen' })
    expect(cell('claude', 'terminal', 'network')).toEqual({ level: 'partial', note: 'web-tools-only' })
    expect(cell('claude', 'chat', 'network')).toEqual({ level: 'partial', note: 'web-tools-only' })
    expect(cell('codex', 'terminal', 'file-read')).toEqual({ level: 'partial', note: 'shell-text-only' })
    expect(cell('codex', 'terminal', 'network')).toEqual({ level: 'partial', note: 'web-search-and-shell-text' })
    expect(cell('codex', 'chat', 'file-read')).toEqual({ level: 'partial', note: 'shell-text-only' })
    expect(cell('codex', 'chat', 'network')).toEqual({ level: 'partial' })
  })
})
