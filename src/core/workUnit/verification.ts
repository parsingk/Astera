// What the agent reported running, turned into one word.
//
// **The app did not run any of this.** The value of the field is the opposite of what it looks
// like: it shows what was *not* run. An agent that reports nothing gets `unverified`, which is
// honest, rather than `verified`, which would be a claim nobody made.
import type { SessionCheck } from './types'
import type { Verification } from '../understanding/types'

const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped'])

export function verificationOf(checks: readonly SessionCheck[] | undefined): Verification {
  if (!checks || checks.length === 0) return 'unverified'
  if (checks.some((c) => c.status === 'failed')) return 'failed'
  const passed = checks.filter((c) => c.status === 'passed').length
  if (passed === 0) return 'unverified'
  return passed === checks.length ? 'verified' : 'partial'
}

/** `--check <name>=<status>` as the agent typed it. The name is its own words and may contain
 *  anything but the first '='; the status is the closed set above, because a typo that silently
 *  became a fourth status would read as "not failed" everywhere downstream. */
export function parseCheckFlag(raw: string): SessionCheck | { error: string } {
  const at = raw.indexOf('=')
  const name = at < 0 ? '' : raw.slice(0, at).trim()
  const status = at < 0 ? '' : raw.slice(at + 1).trim()
  if (at < 0 || name === '' || status === '') return { error: `check must be <name>=<status>: ${raw}` }
  if (!CHECK_STATUSES.has(status))
    return { error: `check status must be passed, failed or skipped: ${raw}` }
  return { name, status: status as SessionCheck['status'] }
}
