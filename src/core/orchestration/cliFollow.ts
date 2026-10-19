// What `astera runs follow` prints for one timeline event (CLI spec §22).
//
// **The events are the Jobs view's own** (timeline.ts `timelineFor`): derived from the records that
// already carry their times, never a second log. What this file adds is only the words.
//
// **The human line has no contract**, like every `--human` shape (cliHuman.ts). A script reads the
// JSON lines, one envelope per event, and branches on `event.kind`.
//
// Pure: no clock of its own and no process. `clockOf` reads the local time zone, which is the point:
// a person watching a follow compares it with the clock on the wall.
import type { JobEvent } from '../types'

const two = (n: number): string => String(n).padStart(2, '0')

/** `14:21:02`, local time. An `at` that does not parse is printed as it came, not as `NaN:NaN:NaN`. */
export function clockOf(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** Which event this is, across polls: the SDK package's rule (packages/client/src/follow.ts), so the CLI, MCP and
 *  @astera-app/client each show an event once by the same key. */
export { eventKey } from '../publicContract'

/** A summary is often a first line already, but a message subject is whatever its writer sent. */
const oneLine = (text: string | undefined): string => (text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()

/** A GitHub lifecycle Run's steps (G7b), the commit, check or pull request after them. */
const GITHUB_WORDS: Partial<Record<JobEvent['kind'], string>> = {
  'github-pr-bound': 'pull request bound',
  'github-pr-created': 'pull request opened',
  'github-pushed': 'pushed',
  'github-ci-started': 'GitHub CI started',
  'github-ci-failed': 'GitHub CI failed',
  'github-ci-rerun': 'GitHub CI rerun',
  'github-ci-passed': 'GitHub CI passed',
  'github-merge-ready': 'merge-ready',
  'github-invalidated': 'not merge-ready',
  'github-source-changed': 'source issue changed'
}

function whatHappened(e: JobEvent): string {
  const task = e.taskId ?? ''
  const summary = oneLine(e.summary)
  switch (e.kind) {
    case 'run-created':
      return `run created: ${summary}`
    case 'task-created':
      return `task created: ${task} ${summary}`
    case 'dispatch-started': {
      const who = e.review === true ? 'reviewer' : e.repair !== undefined ? 'repair worker' : 'worker'
      const why = e.repair !== undefined ? ` (${e.repair})` : e.retry === true ? ' (retry)' : ''
      return `${who} started: ${task}${why}`
    }
    case 'limit-hit':
      return `usage limit hit: ${task}`
    case 'resumed':
      return `worker resumed: ${task}`
    case 'gate-opened':
      return `question opened: ${task}: ${summary}`
    case 'gate-resolved':
      return `question answered: ${task}${summary === '' ? '' : `: ${summary}`}`
    // The Host journal's rows (J7). The recovery summary is the strategy as journaled; its reason is
    // the body, which the public filter holds back.
    case 'runtime-lost':
      return `worker lost: ${task}`
    case 'recovery':
      return `recovery: ${task}${summary === '' ? '' : `: ${summary}`}`
    case 'message':
      if (e.messageType === 'worker_done')
        return `worker done: ${task}${e.outcome ? ` (${e.outcome})` : ''}${summary === '' ? '' : `: ${summary}`}`
      return `${summary}${task === '' ? '' : ` (${task})`}`
    default: {
      const words = GITHUB_WORDS[e.kind]
      if (words !== undefined) return `${words}${summary === '' ? '' : `: ${summary}`}`
      return `${e.kind}: ${summary}`
    }
  }
}

/** `[14:21:02] worker started: task_1` */
export const followLine = (e: JobEvent): string => `[${clockOf(e.at)}] ${whatHappened(e)}`
