// The shared skill, command and agent findings (lifecycle design §4.12): one Claude Code reported no use of in 30 days of
// Observe history is unused, but only where every CLI it is installed for could have reported a use. Codex never can for
// a skill, so a skill for both CLIs gets an information line at most; Claude cannot before USE_REPORT_MIN_CLAUDE, nor for
// a skill or command typed into a chat session. Nothing younger than the window, and nothing switched off, is judged.
import { describe, it, expect } from 'vitest'
import type { ExtensionEntry, FileExtension } from '../../extensions/types'
import type { FindingInputs } from '../compute'
import { emptyUse } from '../usage'
import type { ExtensionCopy, ExtensionUseSummary, ObservedUse } from '../types'
import { USE_REPORT_MIN_CLAUDE, agentNameKey, extensionUseFindings, extensionUseInfo } from './extensionUse'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

const item = (kind: FileExtension['kind'], name: string, over: Partial<FileExtension> = {}): FileExtension => ({
  id: `${kind}-${name}`,
  kind,
  name,
  hash: 'h',
  providers: kind === 'skill' ? ['claude', 'codex'] : ['claude'],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: ago(40),
  ...over
})
const used = (skillOrCommand: string[] = [], agents: string[] = []): ExtensionUseSummary => ({ skillOrCommand: new Set(skillOrCommand), agents: new Set(agents) })
/** Each skill and agent's copy, as the reader finds it: no frontmatter unless the test says. */
const copiesOf = (registry: ExtensionEntry[], over: Record<string, ExtensionCopy> = {}): Map<string, ExtensionCopy> =>
  new Map(registry.filter((e) => e.kind === 'skill' || e.kind === 'agent').map((e) => [e.id, over[e.id] ?? {}]))

/** Observe on for 30 days, this release's first run 40 days ago, Claude Code new enough to report every use. */
const inputs = (registry: ExtensionEntry[], over: Partial<FindingInputs> & { copies?: Record<string, ExtensionCopy> } = {}): FindingInputs => {
  const { copies, ...rest } = over
  return {
    nowMs: NOW,
    platform: 'linux',
    findingsSince: ago(40),
    policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' },
    observe: { on: true, days: 30 },
    observed: emptyUse(),
    registry,
    extensionUses: used(),
    extensionCopies: copiesOf(registry, copies),
    claudeVersion: USE_REPORT_MIN_CLAUDE,
    ...rest
  }
}
const keys = (i: FindingInputs): string[] => extensionUseFindings(i).map((f) => f.key)
const lines = (i: FindingInputs): Array<[string, string]> => extensionUseInfo(i).map((l) => [l.subject.id, l.reason])

describe('unused-command (§4.12)', () => {
  it('a shared command added 40 days ago with no use is unused-command', () => {
    const found = extensionUseFindings(inputs([item('command', 'ship')]))
    expect(found).toEqual([
      {
        key: 'unused-command:command-ship',
        rule: 'unused-command',
        subject: { kind: 'extension', id: 'command-ship', name: 'ship' },
        profileIds: [],
        message: { key: 'findings.reason.unusedExtension', params: { days: 30 } },
        reason: 'No recorded use in 30 days.',
        suggestion: { key: 'findings.do.removeExtension' },
        action: 'Remove it from the shared extensions.',
        open: { kind: 'extension', entryId: 'command-ship' },
        ignored: false
      }
    ])
    expect(extensionUseInfo(inputs([item('command', 'ship')]))).toEqual([])
  })

  it('a command used as /name (slash) is not', () => {
    expect(keys(inputs([item('command', 'ship')], { extensionUses: used(['ship']) }))).toEqual([])
  })

  it('a command used through the Skill tool (skill-tool name equal to the file name) is not', () => {
    // The summary does not keep which way a name came: both ways are the same set
    expect(keys(inputs([item('command', 'ship')], { extensionUses: used(['ship']) }))).toEqual([])
    // Another name, or a plugin's name that ends the same, is not this command's use
    expect(keys(inputs([item('command', 'ship')], { extensionUses: used(['Ship', 'p:ship']) }))).toEqual(['unused-command:command-ship'])
  })

  // Research §3 C-4: a skill and a command of the same name, and the skill wins, so the command can never run
  it('a command whose name a shared skill also has is unused-command even if that name was used', () => {
    const registry = [item('command', 'ship'), item('skill', 'ship', { providers: ['claude'] })]
    expect(keys(inputs(registry, { extensionUses: used(['ship']) }))).toEqual(['unused-command:command-ship'])
    // A skill whose frontmatter names it so wins the same way
    const named = [item('command', 'ship'), item('skill', 'shipping', { providers: ['claude'] })]
    expect(keys(inputs(named, { extensionUses: used(['ship']), copies: { 'skill-shipping': { name: 'ship' } } }))).toEqual(['unused-command:command-ship'])
    // A skill switched off is not given to the CLIs, so the command runs
    const off = [item('command', 'ship'), item('skill', 'ship', { providers: ['claude'], enabled: false })]
    expect(keys(inputs(off, { extensionUses: used(['ship']) }))).toEqual([])
  })
})

describe('unused-agent (§4.12)', () => {
  it('a shared agent whose frontmatter name is "Code Reviewer" used as agent_type "Code Reviewer" or subagent_type "code-reviewer" is used', () => {
    const registry = [item('agent', 'reviewer')]
    const copies = { 'agent-reviewer': { name: 'Code Reviewer' } }
    expect(keys(inputs(registry, { copies, extensionUses: used([], ['Code Reviewer']) }))).toEqual([])
    expect(keys(inputs(registry, { copies, extensionUses: used([], ['code-reviewer']) }))).toEqual([])
    expect(keys(inputs(registry, { copies, extensionUses: used([], ['code_reviewer']) }))).toEqual([])
    // Its file name is not what Claude Code names it, and a plugin's agent of that name is another agent
    expect(keys(inputs(registry, { copies, extensionUses: used([], ['reviewer', 'p:code-reviewer']) }))).toEqual(['unused-agent:agent-reviewer'])
    // With no frontmatter name, the file name
    expect(keys(inputs(registry, { extensionUses: used([], ['Reviewer']) }))).toEqual([])
    // A skill-or-command name is not an agent's use
    expect(keys(inputs(registry, { copies, extensionUses: used(['code-reviewer']) }))).toEqual(['unused-agent:agent-reviewer'])
  })

  it('a shared agent with no use is unused-agent', () => {
    const found = extensionUseFindings(inputs([item('agent', 'reviewer')]))
    expect(found.map((f) => [f.key, f.rule, f.reason, f.action, f.open])).toEqual([
      ['unused-agent:agent-reviewer', 'unused-agent', 'No recorded use in 30 days.', 'Remove it from the shared extensions.', { kind: 'extension', entryId: 'agent-reviewer' }]
    ])
  })

  it('agentNameKey lowercases and turns each run of spaces and underscores into one hyphen', () => {
    expect(agentNameKey('Code Reviewer')).toBe('code-reviewer')
    expect(agentNameKey('code__ _reviewer')).toBe('code-reviewer')
    expect(agentNameKey('code-reviewer')).toBe('code-reviewer')
  })
})

describe('unused-skill (§4.12)', () => {
  it('a skill for both CLIs with no use gives no finding and one info line: No recorded use in Claude in 30 days. Codex cannot tell.', () => {
    const i = inputs([item('skill', 'review')])
    expect(extensionUseFindings(i)).toEqual([])
    expect(extensionUseInfo(i)).toEqual([
      {
        subject: { kind: 'extension', id: 'skill-review', name: 'review' },
        message: { key: 'findings.info.claudeOnlyNoUse', params: { days: 30 } },
        reason: 'No recorded use in Claude in 30 days. Codex cannot tell.'
      }
    ])
    // Used in Claude: no line
    expect(extensionUseInfo(inputs([item('skill', 'review')], { extensionUses: used(['review']) }))).toEqual([])
  })

  it('a skill for Claude only with no use is unused-skill', () => {
    const i = inputs([item('skill', 'review', { providers: ['claude'] })])
    expect(keys(i)).toEqual(['unused-skill:skill-review'])
    expect(extensionUseInfo(i)).toEqual([])
    expect(keys(inputs([item('skill', 'review', { providers: ['claude'] })], { extensionUses: used(['review']) }))).toEqual([])
  })

  it('a skill matched by its frontmatter name counts as used', () => {
    const registry = [item('skill', 'review-helper', { providers: ['claude'] }), item('skill', 'both')]
    const copies = { 'skill-review-helper': { name: 'review' }, 'skill-both': { name: 'both-named' } }
    const i = inputs(registry, { copies, extensionUses: used(['review', 'both-named']) })
    expect(keys(i)).toEqual([])
    expect(extensionUseInfo(i)).toEqual([])
  })

  // Research §3 C-7: a skill an agent's `skills:` preloads is put in its context with no event at all
  it('a skill named in a shared agent’s skills: frontmatter gives neither a finding nor a line', () => {
    const registry = [item('skill', 'conventions', { providers: ['claude'] }), item('skill', 'both'), item('agent', 'api', { enabled: false })]
    const i = inputs(registry, { copies: { 'agent-api': { name: 'api-developer', skills: ['conventions', 'both'] } }, extensionUses: used([], ['api-developer']) })
    expect(keys(i)).toEqual([])
    expect(extensionUseInfo(i)).toEqual([])
    // By its frontmatter name too
    const named = inputs([item('skill', 'conv', { providers: ['claude'] }), item('agent', 'api')], {
      copies: { 'skill-conv': { name: 'conventions' }, 'agent-api': { skills: ['conventions'] } },
      extensionUses: used([], ['api'])
    })
    expect(keys(named)).toEqual([])
  })

  it('a skill whose copy, or any shared agent’s copy, could not be read is not judged', () => {
    const registry = [item('skill', 'review', { providers: ['claude'] }), item('agent', 'api')]
    const unreadSkill = inputs(registry, { extensionUses: used([], ['api']) })
    unreadSkill.extensionCopies = new Map([['agent-api', {}]])
    expect(keys(unreadSkill)).toEqual([])
    const unreadAgent = inputs(registry)
    unreadAgent.extensionCopies = new Map([['skill-review', {}]])
    // The agent itself is not judged either: what Claude Code names it is not known
    expect(keys(unreadAgent)).toEqual([])
    expect(extensionUseInfo(unreadAgent)).toEqual([])
  })
})

describe('when nothing is raised (§4.12, never on missing data)', () => {
  const registry = (): ExtensionEntry[] => [item('command', 'ship'), item('agent', 'reviewer'), item('skill', 'solo', { providers: ['claude'] }), item('skill', 'both')]
  const cannotTell = (id: string): [string, string] => [id, `Claude cannot tell: it needs Claude Code ${USE_REPORT_MIN_CLAUDE} or later to report uses.`]

  it("claudeVersion '2.1.306': no finding; each Claude-only item gets a \"Claude cannot tell\" info line", () => {
    const i = inputs(registry(), { claudeVersion: '2.1.306' })
    expect(keys(i)).toEqual([])
    // The skill for both CLIs reads the same: what Claude did not report cannot say it went unused there
    expect(lines(i)).toEqual([cannotTell('command-ship'), cannotTell('agent-reviewer'), cannotTell('skill-solo'), cannotTell('skill-both')])
    expect(extensionUseInfo(i)[0].message).toEqual({ key: 'findings.info.claudeCannotTell', params: { min: '2.1.312' } })
    // A recorded use still shows it was used
    expect(lines(inputs(registry(), { claudeVersion: '2.1.306', extensionUses: used(['ship']) })).map(([id]) => id)).not.toContain('command-ship')
    // Later versions report
    expect(keys(inputs(registry(), { claudeVersion: '2.2.0' }))).toEqual(['unused-command:command-ship', 'unused-agent:agent-reviewer', 'unused-skill:skill-solo'])
  })

  it('claudeVersion null: the same', () => {
    const i = inputs(registry(), { claudeVersion: null })
    expect(keys(i)).toEqual([])
    expect(lines(i)).toEqual([cannotTell('command-ship'), cannotTell('agent-reviewer'), cannotTell('skill-solo'), cannotTell('skill-both')])
  })

  it('added 10 days ago: not judged', () => {
    const young = registry().map((e) => ({ ...e, addedAt: ago(10) }))
    expect(keys(inputs(young))).toEqual([])
    expect(lines(inputs(young))).toEqual([])
    // No addedAt: aged from this release's first run
    const unstamped = registry().map((e) => ({ ...e, addedAt: undefined }))
    expect(keys(inputs(unstamped))).toHaveLength(3)
    // Switched back on 10 days ago (ruling R4-3): aged from then
    const switched = registry().map((e) => ({ ...e, addedAt: ago(90), enabledAt: ago(10) }))
    expect(keys(inputs(switched))).toEqual([])
    expect(lines(inputs(switched))).toEqual([])
  })

  it('findingsSince 10 days ago: not judged', () => {
    const i = inputs(registry(), { findingsSince: ago(10) })
    expect(keys(i)).toEqual([])
    expect(lines(i)).toEqual([])
  })

  it('20 days of Observe history: not judged', () => {
    const i = inputs(registry(), { observe: { on: true, days: 20 } })
    expect(keys(i)).toEqual([])
    expect(lines(i)).toEqual([])
    expect(keys(inputs(registry(), { observe: { on: false, days: 0 } }))).toEqual([])
  })

  it('a disabled entry is not judged', () => {
    const off = registry().map((e) => ({ ...e, enabled: false }))
    expect(keys(inputs(off))).toEqual([])
    expect(lines(inputs(off))).toEqual([])
    expect(lines(inputs(off, { claudeVersion: null }))).toEqual([])
  })

  // Step 0: a skill or command a person types into a Claude chat (`-p`, stream-json) is expanded before the model runs,
  // with no Skill call in the stream and no hook, so a chat session in the window could have used one unseen
  it('with a Claude chat session seen in the window (claudeChatSeen), commands and Claude-only skills read "Claude cannot tell"', () => {
    const observed: ObservedUse = { ...emptyUse(), claudeChatSeen: true }
    const i = inputs(registry(), { observed })
    // An agent is still told: a chat names it in its Agent call
    expect(keys(i)).toEqual(['unused-agent:agent-reviewer'])
    const chat = (id: string): [string, string] => [id, 'Claude cannot tell: a Claude chat ran in these 30 days, and a skill or command typed in a chat is not reported.']
    expect(lines(i)).toEqual([chat('command-ship'), chat('skill-solo'), chat('skill-both')])
    // A use recorded anyway still counts
    expect(lines(inputs(registry(), { observed, extensionUses: used(['ship', 'solo', 'both']) }))).toEqual([])
  })
})
