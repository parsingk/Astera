// The shared skill, command and agent findings (lifecycle design §4.12): one with no use Claude Code reported in 30 days
// of Observe history. Only what a CLI reports exactly is a use (research cli-use-reporting.md): Claude reports each one,
// Codex none, since its main path to a skill is the model reading SKILL.md through the shell (plan ruling 14). So a
// finding is raised only for an item every CLI it is installed for can report, which leaves a skill shared with Codex an
// information line at most, and commands and agents (Claude's alone) the findings. Claude cannot report either before
// USE_REPORT_MIN_CLAUDE (ruling 15), nor a skill or command a person types into a chat session (Step 0, ruling R6-1): the
// item then reads "Claude cannot tell", and for one installed for Codex too, that neither can (ruling R6-4). Nothing
// switched off, younger than the window, or judged on a copy that could not be read is said to be unused: "never call
// something unused on missing data" (§4). Names and ids only (§8).
import { USE_REPORT_MIN_CLAUDE, reportsUses } from '../../sessions/cliVersion'
import type { ExtensionEntry, FileExtension } from '../../extensions/types'
import type { Message } from '../../i18n'
import type { FindingInputs } from '../compute'
import { OBSERVE_WINDOW_DAYS, ageDays } from '../history'
import { finding, infoLine } from '../make'
import type { Finding, FindingRule, FindingSubject, InfoLine } from '../types'
import { entryAgeDays } from './extensions'

export { USE_REPORT_MIN_CLAUDE } from '../../sessions/cliVersion'

/** An agent's name as Claude Code matches `subagent_type`: lowercased, each run of spaces and `_` one `-` (CHANGELOG
 *  2.1.140, "Code Reviewer" → `code-reviewer`). An agent's `agent_type` is its frontmatter name as written. */
export const agentNameKey = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-')

/** A skill's or command's name as a use is matched to it (ruling R6-2): whatever its case. Matching more loosely only
 *  ever counts more uses, never raises a finding. */
const useKey = (s: string): string => s.toLowerCase()

const RULE: Record<FileExtension['kind'], FindingRule> = { skill: 'unused-skill', command: 'unused-command', agent: 'unused-agent' }

const isFile = (e: ExtensionEntry): e is FileExtension => e.kind !== 'mcp'

/** A reported name with `:` is a plugin's, a nested folder's or an added directory's, never a shared item. */
const astera = (names: Set<string>): string[] => [...names].filter((n) => !n.includes(':'))

const subjectOf = (e: FileExtension): FindingSubject => ({ kind: 'extension', id: e.id, name: e.name })

/** Each item judged, with what it reads: a finding, or the information line it gets instead. */
type Verdict = { e: FileExtension; line: Message | null }

function verdicts(i: FindingInputs): Verdict[] {
  const { registry, extensionUses, extensionCopies, observe } = i
  if (registry === undefined || extensionUses === undefined || extensionCopies === undefined || observe === undefined) return []
  // The use log began with this release, and judges only a full window of Observe history
  if (!(observe.days >= OBSERVE_WINDOW_DAYS) || !(ageDays(i.findingsSince, i.nowMs) >= OBSERVE_WINDOW_DAYS)) return []
  const files = registry.filter(isFile)
  const skillOrCommand = new Set(astera(extensionUses.skillOrCommand).map(useKey))
  const agentKeys = new Set(astera(extensionUses.agents).map(agentNameKey))
  /** A skill's names: its folder, and the frontmatter name Claude Code also calls it by. */
  const skillNames = (e: FileExtension): string[] => {
    const own = extensionCopies.get(e.id)?.name
    return own === undefined ? [e.name] : [e.name, own]
  }
  const skills = files.filter((e) => e.kind === 'skill')
  const agents = files.filter((e) => e.kind === 'agent')
  // Research §3 C-7 (ruling 17): a skill an agent's `skills:` names is injected with no event. Every shared agent counts,
  // on or off, and one whose copy could not be read may name any skill
  const agentsRead = agents.every((a) => extensionCopies.has(a.id))
  const preloaded = new Set(agents.flatMap((a) => extensionCopies.get(a.id)?.skills ?? []).map(useKey))
  // Research §3 C-8 (ruling R6-5): the agent a `context: fork` skill's `agent:` names may start with no SubagentStart. Every
  // shared skill counts, and one whose copy could not be read may name any agent
  const skillsRead = skills.every((s) => extensionCopies.has(s.id))
  const forkAgents = new Set(skills.flatMap((s) => extensionCopies.get(s.id)?.agent ?? []).map(agentNameKey))
  // Research §3 C-4: a skill wins over a command of the same name, so that command never runs. Only a skill Claude is
  // given, under the very same name (ruling R6-2): one switched off, or for Codex alone, leaves the command its name
  const shadowing = new Set(skills.filter((e) => e.enabled && e.providers.includes('claude')).flatMap(skillNames))
  const reports = reportsUses(i.claudeVersion)

  const out: Verdict[] = []
  for (const e of files) {
    if (!e.enabled || !e.providers.includes('claude') || !(entryAgeDays(e, i) >= OBSERVE_WINDOW_DAYS)) continue
    let used: boolean
    if (e.kind === 'skill') {
      if (!extensionCopies.has(e.id) || !agentsRead) continue
      const names = skillNames(e).map(useKey)
      if (names.some((n) => preloaded.has(n))) continue
      used = names.some((n) => skillOrCommand.has(n))
    } else if (e.kind === 'command') {
      used = skillOrCommand.has(useKey(e.name)) && !shadowing.has(e.name)
    } else {
      const copy = extensionCopies.get(e.id)
      if (copy === undefined || !skillsRead) continue
      const key = agentNameKey(copy.name ?? e.name)
      if (forkAgents.has(key)) continue
      used = agentKeys.has(key)
    }
    // A recorded use is a use, whatever else could not be seen
    if (used) continue
    // Codex cannot tell (ruling 14): Claude's silence is information, not a finding, and says Codex cannot tell either
    const codexToo = e.providers.some((p) => p !== 'claude')
    if (!reports)
      out.push({ e, line: { key: codexToo ? 'findings.info.claudeCannotTellCodexToo' : 'findings.info.claudeCannotTell', params: { min: USE_REPORT_MIN_CLAUDE } } })
    else if (e.kind !== 'agent' && extensionUses.claudeChatSeen)
      out.push({ e, line: { key: codexToo ? 'findings.info.claudeChatCannotTellCodexToo' : 'findings.info.claudeChatCannotTell', params: { days: OBSERVE_WINDOW_DAYS } } })
    else if (codexToo) out.push({ e, line: { key: 'findings.info.claudeOnlyNoUse', params: { days: OBSERVE_WINDOW_DAYS } } })
    else out.push({ e, line: null })
  }
  return out
}

/** §4.12's findings: an item installed for Claude alone that Claude reported no use of. Each opens the extension. */
export function extensionUseFindings(i: FindingInputs): Finding[] {
  return verdicts(i).flatMap(({ e, line }) =>
    line !== null
      ? []
      : [
          finding({
            rule: RULE[e.kind],
            subject: subjectOf(e),
            message: { key: 'findings.reason.unusedExtension', params: { days: OBSERVE_WINDOW_DAYS } },
            suggestion: { key: 'findings.do.removeExtension' },
            open: { kind: 'extension', entryId: e.id }
          })
        ]
  )
}

/** §4.12's information lines: an item with no recorded use that a CLI it is installed for cannot tell about. Never a
 *  finding, never ignored. */
export function extensionUseInfo(i: FindingInputs): InfoLine[] {
  return verdicts(i).flatMap(({ e, line }) => (line === null ? [] : [infoLine(subjectOf(e), line)]))
}
