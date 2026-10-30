// Building a finding (lifecycle design §4, §6): its key, and its reason and action in English beside the Messages, so the
// CLI and --json print the words the app shows an English reader (plan Global Constraints, Text). And how a reason names
// a Job, a Task and a Run: by names and ids only, one line each (§8).
import { t, type Message } from '../i18n'
import { jobNameOf } from '../orchestration/jobName'
import type { OrchState } from '../orchestration/state'
import type { JobSourceRef } from '../orchestration/types'
import type { Finding, FindingPlace, FindingRule, FindingSubject } from './types'

/** `rule:subject`, plus `:part` for over-broad-profile's lines (spec §6) and a coverage gap's Rule. An ignore is kept by
 *  this key. */
export function findingKey(rule: FindingRule, subjectId: string, part?: string): string {
  return part === undefined ? `${rule}:${subjectId}` : `${rule}:${subjectId}:${part}`
}

/** Builds a Finding: reason = t('en', message.key, message.params), action = t('en', suggestion…), ignored false. */
export function finding(a: {
  rule: FindingRule
  subject: FindingSubject
  message: Message
  suggestion: Message
  open: FindingPlace
  profileIds?: string[]
  part?: string
}): Finding {
  return {
    key: findingKey(a.rule, a.subject.id, a.part),
    rule: a.rule,
    subject: a.subject,
    profileIds: a.profileIds ?? [],
    ...(a.part !== undefined ? { part: a.part } : {}),
    message: a.message,
    reason: t('en', a.message.key, a.message.params),
    suggestion: a.suggestion,
    action: t('en', a.suggestion.key, a.suggestion.params),
    open: a.open,
    ignored: false
  }
}

/** The most characters a name in a finding keeps, as the run record keeps a Job's name (runRecord.ts). */
const NAME_MAX = 60

/** A name on one line, cut at NAME_MAX with a mark: a Job with no ticket title is named by its objective, which may run to
 *  paragraphs, and a finding names it, never quotes it. */
export function oneLineName(text: string): string {
  const line = Array.from(text.replace(/\s+/g, ' ').trim())
  return line.length <= NAME_MAX ? line.join('') : `${line.slice(0, NAME_MAX - 1).join('')}…`
}

/** A Job as every other place names it (jobName.ts), on one line. */
export const jobName = (job: { objective: string; source?: JobSourceRef }): string => oneLineName(jobNameOf(job))

/** A Run as a reason names it: its Job's name with its ordinal (`Nightly review #3`), or `run <id>` when the Run or its
 *  Job is not in the state. */
export function runName(orch: OrchState, runId: string): string {
  const run = orch.runs.find((r) => r.id === runId)
  const job = run === undefined ? undefined : orch.jobs.find((j) => j.id === run.jobId)
  return run !== undefined && job !== undefined ? `${jobName(job)} #${run.ordinal}` : `run ${runId}`
}
