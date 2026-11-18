import type { ResourceOutcome } from './types'

type Outcome = ResourceOutcome['outcome']

// `deployment.apps/api-server configured` (apply, or delete with -o name)
const SLASH_LINE = /^([^\s"/]+\/\S+) ([a-z][a-z-]*)(?: \([^)]*\))?$/
// `deployment.apps "api-server" deleted` (plain delete)
const QUOTED_LINE = /^([^\s"/]+) "([^"]+)" ([a-z][a-z-]*)(?: \([^)]*\))?$/
const FILE_ERROR = /^Error from server \([^)]*\): error when \w+ "([^"]+)": (.*)$/

/** Only these verbs count as success; the variants keep kubectl's own word as the message. */
const VERBS: Record<string, { outcome: Outcome; message?: string }> = {
  created: { outcome: 'created' },
  configured: { outcome: 'configured' },
  unchanged: { outcome: 'unchanged' },
  deleted: { outcome: 'deleted' },
  'serverside-applied': { outcome: 'configured', message: 'serverside-applied' },
  patched: { outcome: 'configured', message: 'patched' },
  pruned: { outcome: 'deleted', message: 'pruned' }
}

function success(ref: string, verb: string): ResourceOutcome | null {
  const v = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined
  if (!v) return null
  return v.message ? { ref, outcome: v.outcome, message: v.message } : { ref, outcome: v.outcome }
}

/**
 * One outcome per meaningful line of kubectl's stdout and stderr (kubectl mixes them).
 * A whitelisted success line gives its outcome, `Warning:` lines become `warning` outcomes,
 * and every other line becomes an `error` carrying the whole line, so nothing the person needs is dropped.
 */
export function parseKubectlOutput(stdout: string, stderr: string): ResourceOutcome[] {
  const outcomes: ResourceOutcome[] = []
  for (const raw of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('Warning:')) {
      outcomes.push({ ref: '', outcome: 'warning', message: line.slice('Warning:'.length).trim() })
      continue
    }
    const slash = SLASH_LINE.exec(line)
    const quoted = slash ? null : QUOTED_LINE.exec(line)
    const ok = slash
      ? success(slash[1], slash[2])
      : quoted
        ? success(`${quoted[1]}/${quoted[2]}`, quoted[3])
        : null
    if (ok) {
      outcomes.push(ok)
      continue
    }
    const fileError = FILE_ERROR.exec(line)
    if (fileError) {
      outcomes.push({ ref: '', outcome: 'error', file: fileError[1], message: fileError[2] })
      continue
    }
    outcomes.push({ ref: '', outcome: 'error', message: line })
  }
  return outcomes
}
