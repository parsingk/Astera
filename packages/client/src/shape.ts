// Shapes what the Host answers into the public fields (fields.ts). The CLI, its MCP server and the SDK call this one
// function, so the three cannot drift apart.
import {
  ACCOUNT_FIELDS,
  AGENT_PROFILE_FIELDS,
  CHAT_PENDING_FIELDS,
  CHAT_PROMPT_FIELDS,
  CHAT_TURN_FIELDS,
  CHECK_FIELDS,
  COMPLETION_CHECK_FIELDS,
  COMPLETION_DETAIL_FIELDS,
  COMPLETION_FIELDS,
  DERIVED_FIELDS,
  EVENT_FIELDS,
  EVENT_SESSION_FIELDS,
  EVENT_TYPES,
  FOLLOW_EVENT_FIELDS,
  JOB_FIELDS,
  PROJECT_FIELDS,
  QUESTION_FIELDS,
  REVIEW_FIELDS,
  REVIEW_ISSUE_FIELDS,
  RUN_CHECKS_FIELDS,
  RUN_CONFIG_FIELDS,
  RUN_FIELDS,
  SESSION_EVENT_FIELDS,
  SESSION_FIELDS,
  SKILL_INSTALLED_FIELDS,
  SKILL_LISTED_FIELDS,
  SKILL_NOT_ENABLED_FIELDS,
  SKILLS_ACCOUNT_FIELDS,
  TASK_CHECKS_FIELDS,
  TASK_COMPLETION_FIELDS,
  TASK_FIELDS,
  VALIDATION_FIELDS
} from './fields.js'
import type { EventType } from './types.js'

/** `archivedProfiles` is derived by `jobs list` and `jobs get` alone, and only when there is one: the archived agent
 *  profiles a scheduled Job waits on (lifecycle design §5). */
const JOB = [...JOB_FIELDS, ...DERIVED_FIELDS, 'archivedProfiles']
/** Derived like DERIVED_FIELDS, by `runs get` alone and only when above zero: how many of the Run's Tasks have a
 *  worker showing a permission prompt. `github` is derived for a GitHub lifecycle Job's Run on every read. `tokens` and
 *  `coordinatorTokens`, by `runs get` alone too and only when known: what its Tasks' sessions and its coordinator's
 *  spent. */
const RUN = [...RUN_FIELDS, ...DERIVED_FIELDS, 'waitingForApproval', 'github', 'tokens', 'coordinatorTokens']
/** `tasks list --brief` adds the mark of where it cut a spec. A Task has no such field, so it is allowed here by
 *  name: left off this list, `--brief` would silently lose the mark. */
const TASK = [...TASK_FIELDS, 'spec_truncated']
/** `sessions read` has two shapes: a terminal (screen, size, scrollback) and a chat (turns and the open card). */
const SESSION_READ = ['id', 'kind', 'alive', 'cols', 'rows', 'screen', 'scrollback', 'screenWrapped', 'scrollbackWrapped', 'turns', 'pending'] as const
const SESSION_SEND = ['id', 'sent', 'enter', 'turn'] as const
/** `tasks dispatch`: the worker the Host's loop started for the Task. The spec file's path stays on the Host. */
const TASK_DISPATCH = ['taskId', 'runId', 'dispatchId', 'sessionId', 'cwd'] as const
const CHATS_PENDING = ['prompts', 'complete'] as const
const CHATS_ANSWER = ['sessionId', 'id', 'decision', 'answered'] as const

/**
 * Which command publishes what. **A command not in this table is left alone**: the coordinator's own commands are
 * not public surface and outside this contract; shaping them would only stop the guide's reads from working.
 */
const SHAPE: Record<string, readonly string[]> = {
  'projects-list': PROJECT_FIELDS,
  'projects-get': PROJECT_FIELDS,
  'projects-find': PROJECT_FIELDS,
  'jobs-list': JOB,
  'jobs-get': JOB,
  'jobs-create': JOB,
  // Plugin Phase 4 J21: the Job made from a source's item
  'jobs-create-from-source': JOB,
  'runs-list': RUN,
  'runs-get': RUN,
  // `jobs run` answers with the Run it started, so it hides what `runs get` hides.
  'jobs-run': RUN,
  // `runs resume` answers with the Run it took back, so it hides the same.
  'runs-resume': RUN,
  'tasks-list': TASK,
  'tasks-add': TASK,
  'tasks-dispatch': TASK_DISPATCH,
  'questions-list': QUESTION_FIELDS,
  'questions-get': QUESTION_FIELDS,
  'accounts-list': ACCOUNT_FIELDS,
  'run-configs-list': RUN_CONFIG_FIELDS,
  'sessions-list': SESSION_FIELDS,
  'sessions-read': SESSION_READ,
  'sessions-send': SESSION_SEND,
  'sessions-create': SESSION_FIELDS,
  'chats-pending': CHATS_PENDING,
  'chats-answer': CHATS_ANSWER
}

/** Keeps the allowed fields only. **A missing field is not created**: printing it as `undefined` would vanish from
 *  JSON all the same, but would make "there and empty" and "not there" one shape. */
function pick(fields: readonly string[], obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in obj) out[f] = (obj as Record<string, unknown>)[f]
  return out
}

function shapeOne(cmd: string, fields: readonly string[], x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x
  const picked = pick(fields, x)
  // `jobs get` folds the Run into `run`. What is folded is shaped by the same rules: a leak one layer down is still
  // a leak.
  const run = (x as { run?: unknown }).run
  if (cmd === 'jobs-get' && run !== null && typeof run === 'object') picked.run = pick(RUN, run)
  if (cmd === 'sessions-read') {
    if (Array.isArray(picked.turns))
      picked.turns = picked.turns.map((t: unknown) => (t !== null && typeof t === 'object' ? pick(CHAT_TURN_FIELDS, t) : t))
    // null means "the app looked and there is no card" and is kept as it is, unlike a missing field (no app to ask).
    if (picked.pending !== null && typeof picked.pending === 'object') picked.pending = pick(CHAT_PENDING_FIELDS, picked.pending)
  }
  if (cmd === 'chats-pending' && Array.isArray(picked.prompts))
    picked.prompts = picked.prompts.map((p: unknown) => (p !== null && typeof p === 'object' ? pick(CHAT_PROMPT_FIELDS, p) : p))
  return picked
}

/** `astera skills`: the accounts and the skills folded in each, both layers shaped. Not in `SHAPE`, because the top
 *  level is not one list. */
function shapeSkills(cmd: 'skills-list' | 'skills-install', body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const skill = cmd === 'skills-list' ? SKILL_LISTED_FIELDS : SKILL_INSTALLED_FIELDS
  const list = (v: unknown, f: (x: object) => unknown): unknown =>
    Array.isArray(v) ? v.map((x) => (x !== null && typeof x === 'object' ? f(x) : x)) : v
  const out = pick(cmd === 'skills-list' ? ['accounts'] : ['accounts', 'notEnabled', 'note'], body)
  if ('accounts' in out)
    out.accounts = list(out.accounts, (a) => {
      const row = pick(SKILLS_ACCOUNT_FIELDS, a)
      if ('skills' in row) row.skills = list(row.skills, (x) => pick(skill, x))
      return row
    })
  if ('notEnabled' in out) out.notEnabled = list(out.notEnabled, (x) => pick(SKILL_NOT_ENABLED_FIELDS, x))
  return out
}

/** `runs checks`: all four layers, each held to its own fields. */
function shapeRunChecks(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const obj = (v: unknown, fields: readonly string[]): unknown =>
    v !== null && typeof v === 'object' ? pick(fields, v) : v
  const list = (v: unknown, fields: readonly string[]): unknown =>
    Array.isArray(v) ? v.map((x) => obj(x, fields)) : v
  const out = pick(RUN_CHECKS_FIELDS, body)
  if (Array.isArray(out.tasks))
    out.tasks = out.tasks.map((t: unknown) => {
      if (t === null || typeof t !== 'object') return t
      const row = pick(TASK_CHECKS_FIELDS, t)
      const validation = obj(row.validation, VALIDATION_FIELDS)
      if (validation !== null && typeof validation === 'object' && 'checks' in validation)
        (validation as Record<string, unknown>).checks = list((validation as { checks: unknown }).checks, CHECK_FIELDS)
      if ('validation' in row) row.validation = validation
      const review = obj(row.review, REVIEW_FIELDS)
      if (review !== null && typeof review === 'object' && 'issues' in review)
        (review as Record<string, unknown>).issues = list((review as { issues: unknown }).issues, REVIEW_ISSUE_FIELDS)
      if ('review' in row) row.review = review
      return row
    })
  return out
}

/** One Task's completion row: the row, its detail, and the checks and blocking issues in the detail. */
function shapeTaskCompletion(t: unknown): unknown {
  if (t === null || typeof t !== 'object') return t
  const obj = (v: unknown, fields: readonly string[]): unknown => (v !== null && typeof v === 'object' ? pick(fields, v) : v)
  const list = (v: unknown, fields: readonly string[]): unknown => (Array.isArray(v) ? v.map((x) => obj(x, fields)) : v)
  const row = pick(TASK_COMPLETION_FIELDS, t)
  if (row.detail !== null && typeof row.detail === 'object') {
    const detail = pick(COMPLETION_DETAIL_FIELDS, row.detail)
    if ('checks' in detail) detail.checks = list(detail.checks, COMPLETION_CHECK_FIELDS)
    if ('blockingIssues' in detail) detail.blockingIssues = list(detail.blockingIssues, REVIEW_ISSUE_FIELDS)
    row.detail = detail
  }
  return row
}

/** `runs-completion`: the run and each Task's row. */
function shapeCompletion(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const out = pick(COMPLETION_FIELDS, body)
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(shapeTaskCompletion)
  return out
}

/** The `agent-profiles-*` commands: the Host answers `{ profiles }` for a list and `{ profile }` for one, and the CLI
 *  prints one profile as `jobs get` prints a Job, the profile itself. Not in `SHAPE`, because the profiles are one layer
 *  down in the Host's answers. `agent-profiles-delete` names what went and is left alone. */
const AGENT_PROFILE_COMMANDS: ReadonlySet<string> = new Set([
  'agent-profiles-list',
  'agent-profiles-get',
  'agent-profiles-show',
  'agent-profiles-create',
  'agent-profiles-update',
  'agent-profiles-archive',
  'agent-profiles-restore'
])

function shapeAgentProfiles(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body
  const one = (x: unknown): unknown => (x !== null && typeof x === 'object' ? pick(AGENT_PROFILE_FIELDS, x) : x)
  const o = body as Record<string, unknown>
  if (Array.isArray(o.profiles)) return { profiles: o.profiles.map(one) }
  if ('profile' in o) return { profile: one(o.profile) }
  return one(body)
}

/** The public fields of one followed event. Not in `SHAPE`: `runs follow` answers a stream of these and then one
 *  ending, and the ending is `runs wait`'s body, which no table shapes either. */
export function publicEvent(e: unknown): unknown {
  return e !== null && typeof e === 'object' ? pick(FOLLOW_EVENT_FIELDS, e) : e
}

/** A Run as an event carries it: `runs list`'s fields, without `runs get`'s count of prompts, which only a read asks
 *  the sessions for. */
const EVENT_RUN = [...RUN_FIELDS, ...DERIVED_FIELDS, 'github']

/** One payload by its event's type, shaped like the read that returns that object. A type this package does not
 *  know has no fields to keep. */
function shapePayload(type: unknown, payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const kind = typeof type === 'string' && EVENT_TYPES.includes(type as EventType) ? type.slice(0, type.indexOf('.')) : null
  const list = (v: unknown, fields: readonly string[]): unknown =>
    Array.isArray(v) ? v.map((x) => (x !== null && typeof x === 'object' ? pick(fields, x) : x)) : v
  if (kind === 'job') return pick(JOB, payload)
  // A github event carries the Run it moved, shaped as a run event's (its `github` field says what moved).
  if (kind === 'run' || kind === 'github') return pick(EVENT_RUN, payload)
  if (kind === 'question') return pick(QUESTION_FIELDS, payload)
  if (kind === 'task') {
    const task = pick(TASK, payload)
    if ('checks' in task) task.checks = list(task.checks, CHECK_FIELDS)
    if ('reviewIssues' in task) task.reviewIssues = list(task.reviewIssues, REVIEW_ISSUE_FIELDS)
    return task
  }
  if (kind === 'completion') return shapeTaskCompletion(payload)
  if (kind === 'session') {
    const out = pick(SESSION_EVENT_FIELDS[type as keyof typeof SESSION_EVENT_FIELDS], payload)
    if (out.session !== null && typeof out.session === 'object') out.session = pick(EVENT_SESSION_FIELDS, out.session)
    return out
  }
  return {}
}

/** One public event (SDK spec §6): the envelope's fields, and the payload as its type's DTO. */
export function shapeEvent(e: unknown): unknown {
  if (e === null || typeof e !== 'object') return e
  const out = pick(EVENT_FIELDS, e)
  if ('payload' in out) out.payload = shapePayload(out.type, out.payload)
  return out
}

/** `events-poll`: the page of events, the cursor to read on from, and whether events before it were lost. */
function shapeEventPage(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const out = pick(['events', 'cursor', 'gap'], body)
  if (Array.isArray(out.events)) out.events = out.events.map(shapeEvent)
  return out
}

/** What the Host answered, in the public shape. A command not in the table passes through untouched. */
export function publicFor(cmd: string, body: unknown): unknown {
  if (cmd === 'skills-list' || cmd === 'skills-install') return shapeSkills(cmd, body)
  if (cmd === 'runs-checks') return shapeRunChecks(body)
  if (cmd === 'runs-completion') return shapeCompletion(body)
  if (cmd === 'events-poll') return shapeEventPage(body)
  if (AGENT_PROFILE_COMMANDS.has(cmd)) return shapeAgentProfiles(body)
  // Own keys only: a command named like an Object.prototype key ('constructor') is not in the table
  const fields = Object.hasOwn(SHAPE, cmd) ? SHAPE[cmd] : undefined
  if (fields === undefined) return body
  if (Array.isArray(body)) return body.map((x) => shapeOne(cmd, fields, x))
  return shapeOne(cmd, fields, body)
}
