import type { ResourceOutcome } from './types'

const SUCCESS = /^([^\s"/]+\/\S+) ([a-z][a-z-]*)(?: \([^)]*\))?$/
const FILE_ERROR = /^Error from server \([^)]*\): error when \w+ "([^"]+)": (.*)$/

const KNOWN: Record<string, ResourceOutcome['outcome']> = {
  created: 'created',
  configured: 'configured',
  unchanged: 'unchanged',
  deleted: 'deleted'
}

/**
 * One outcome per meaningful line of kubectl's stdout and stderr (kubectl mixes them).
 * A `type/name verb` line is a success; a verb other than the four known ones (for example
 * `serverside-applied`) is reported as `configured`, since the resource did change.
 * Every other line becomes an `error` carrying the whole line, so nothing the person needs is dropped.
 * `Warning:` lines are skipped: they are advisories (deprecations), not failures.
 */
export function parseKubectlOutput(stdout: string, stderr: string): ResourceOutcome[] {
  const outcomes: ResourceOutcome[] = []
  for (const raw of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('Warning:')) continue
    const ok = SUCCESS.exec(line)
    if (ok) {
      outcomes.push({ ref: ok[1], outcome: KNOWN[ok[2]] ?? 'configured' })
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
