// The app's half of the public field contract (public CLI design §11).
//
// The public field lists and the shaping (`publicFor`) are the SDK package's (packages/client/src/fields.ts and
// shape.ts): one copy for the CLI, MCP and @astera-app/client. What stays here is what only the app can know, its
// internal types and the fields it deliberately keeps back, and the check that ties the two together.
//
// **The compiler catches a missing field.** Add a field to one of these objects without putting it on the package's
// public list or on this file's hidden list, and the typecheck breaks here naming it. An allowlist fails only by
// going stale, and this is what stops that.
import type { CheckResult, Gate, Job, JobRun, Project, ReviewIssue, Task } from './types'
import type { RunChecks, TaskChecks, TaskReview, TaskValidation } from './runChecks'
import type { JobEvent } from '../types'
import type { HostSession, OrchAccount, OrchRunConfig } from './command'
import type { ChatPending, ChatPrompt, ChatTurn } from '../sessions/chatRead'
import type { SkillInstalled, SkillListed, SkillNotEnabled, SkillsAccount } from './skills'
import type { RunCompletion, TaskCompletion } from './runCompletion'
import type { CompletionCheckDetail, CompletionDetail } from './completion'
import type { AgentProfile } from '../agentProfiles/types'
import type {
  ACCOUNT_FIELDS,
  AGENT_PROFILE_FIELDS,
  CHAT_PENDING_FIELDS,
  CHAT_PROMPT_FIELDS,
  CHAT_TURN_FIELDS,
  CHECK_FIELDS,
  COMPLETION_CHECK_FIELDS,
  COMPLETION_DETAIL_FIELDS,
  COMPLETION_FIELDS,
  FOLLOW_EVENT_FIELDS,
  JOB_FIELDS,
  PROJECT_FIELDS,
  QUESTION_FIELDS,
  REVIEW_FIELDS,
  REVIEW_ISSUE_FIELDS,
  RUN_CHECKS_FIELDS,
  RUN_CONFIG_FIELDS,
  RUN_FIELDS,
  SESSION_FIELDS,
  SKILL_INSTALLED_FIELDS,
  SKILL_LISTED_FIELDS,
  SKILL_NOT_ENABLED_FIELDS,
  SKILLS_ACCOUNT_FIELDS,
  TASK_CHECKS_FIELDS,
  TASK_COMPLETION_FIELDS,
  TASK_FIELDS,
  VALIDATION_FIELDS
} from '../publicContract'

export { publicEvent, publicFor, TASK_FIELDS as TASK_PUBLIC_FIELDS } from '../publicContract'

/** The names the two lists leave uncovered. */
type Unlisted<
  T,
  Shown extends readonly PropertyKey[],
  Hidden extends readonly PropertyKey[]
> = Exclude<keyof T, Shown[number] | Hidden[number]>

/** Breaks the compile here, naming what is left, when anything is. An unused alias on purpose: its job is to set up
 *  the type check, not to make a value. */
type NothingLeft<T extends never> = T

/** Held back: the roll tap's bookkeeping of a stopped coordinator, the mark of a coordinator start in flight, the
 *  mark of a coordinator stop not confirmed yet, and the session the inbox net leaves a Run's questions to (an
 *  external coordinator; publishing it would add to the SDK's contract, which nothing has asked for). What a script
 *  needs from the first, that the Run waits for a reset and until when, is the `limited` ending of `runs wait`. Also
 *  held back: the Run's raw GitHub record (`githubState`, GitHub lifecycle), whose public face is the derived `github`
 *  field, and the Host's stamp of when its outcome became final (`endedAt`), which bounds what its coordinator's work is
 *  filed under and is not part of the SDK's contract. */
const RUN_HIDDEN = [
  'coordinatorStop',
  'coordinatorStartingAt',
  'coordinatorStopPending',
  'externalCoordinatorSessionId',
  'githubState',
  'endedAt'
] as const

/** A Job's mark that a sandboxed session made it (final fix pass, C3): the Host's own rule for what its work starts in,
 *  not part of the SDK's contract. */
const JOB_HIDDEN = ['sandboxed'] as const

/**
 * A Task's fields kept back on purpose: all of them **the ledger the app keeps to drive convergence**. The guide
 * tells a coordinator to read `checks`, `consecutiveFailures` and `parentId` (resources/skills/orchestration-guide.md)
 * and never these eight; publishing them would make how the app drives convergence a public API, and every policy
 * change would break someone's script.
 */
const TASK_HIDDEN = [
  'checkHistory',
  'lastFailure',
  'policySnapshot',
  'policyChanged',
  'convergenceStartedAt',
  'convergenceOff',
  'suspiciousFiles',
  'reviewRequested',
  // A skipped round's bookkeeping (plugin Phase 5 C9): its results are the Task's `checks` once it settles
  'checkResume',
  // A sandboxed session added it (final fix pass, C3): the Host's own rule for what its workers start in
  'sandboxed',
  // A lifecycle round handed to the Host (GitHub lifecycle G3a): its results are the Task's `checks` once CI settles it
  'ciWait',
  'ciUnknowns'
] as const

/** A followed event's message body (pages long) and the app's link from an event to a tab. */
// `github` (G7b): a GitHub line's facts for the app's timeline; the public line says them in its summary
const FOLLOW_EVENT_HIDDEN = ['body', 'sessionId', 'github'] as const

// A Job's and a Run's derived fields (the package's DERIVED_FIELDS: outcome, progress, questionsOpen) are not fields
// of the objects, so they are on neither side of these checks.
type _project = NothingLeft<Unlisted<Project, typeof PROJECT_FIELDS, []>>
type _job = NothingLeft<Unlisted<Job, typeof JOB_FIELDS, typeof JOB_HIDDEN>>
type _run = NothingLeft<Unlisted<JobRun, typeof RUN_FIELDS, typeof RUN_HIDDEN>>
type _task = NothingLeft<Unlisted<Task, typeof TASK_FIELDS, typeof TASK_HIDDEN>>
type _question = NothingLeft<Unlisted<Gate, typeof QUESTION_FIELDS, []>>
type _account = NothingLeft<Unlisted<OrchAccount, typeof ACCOUNT_FIELDS, []>>
type _agentProfile = NothingLeft<Unlisted<AgentProfile, typeof AGENT_PROFILE_FIELDS, []>>
type _runConfig = NothingLeft<Unlisted<OrchRunConfig, typeof RUN_CONFIG_FIELDS, []>>
/** The pty and process ids are the Host's own: a controller reads them from the raw reply to subscribe, and a
 *  printed list leaves them out. */
type _session = NothingLeft<Unlisted<HostSession, typeof SESSION_FIELDS, ['ptyId', 'procId']>>
type _chatTurn = NothingLeft<Unlisted<ChatTurn, typeof CHAT_TURN_FIELDS, []>>
type _chatPending = NothingLeft<Unlisted<ChatPending, typeof CHAT_PENDING_FIELDS, []>>
type _chatPrompt = NothingLeft<Unlisted<ChatPrompt, typeof CHAT_PROMPT_FIELDS, []>>
/** The skills types are in core so that core does not import the cli (./skills). */
type _skillsAccount = NothingLeft<Unlisted<SkillsAccount, typeof SKILLS_ACCOUNT_FIELDS, []>>
type _skillListed = NothingLeft<Unlisted<SkillListed, typeof SKILL_LISTED_FIELDS, []>>
type _skillInstalled = NothingLeft<Unlisted<SkillInstalled, typeof SKILL_INSTALLED_FIELDS, []>>
type _skillNotEnabled = NothingLeft<Unlisted<SkillNotEnabled, typeof SKILL_NOT_ENABLED_FIELDS, []>>
type _runChecks = NothingLeft<Unlisted<RunChecks, typeof RUN_CHECKS_FIELDS, []>>
type _taskChecks = NothingLeft<Unlisted<TaskChecks, typeof TASK_CHECKS_FIELDS, []>>
type _validation = NothingLeft<Unlisted<TaskValidation, typeof VALIDATION_FIELDS, []>>
type _review = NothingLeft<Unlisted<TaskReview, typeof REVIEW_FIELDS, []>>
type _check = NothingLeft<Unlisted<CheckResult, typeof CHECK_FIELDS, []>>
type _reviewIssue = NothingLeft<Unlisted<ReviewIssue, typeof REVIEW_ISSUE_FIELDS, []>>
type _followEvent = NothingLeft<Unlisted<JobEvent, typeof FOLLOW_EVENT_FIELDS, typeof FOLLOW_EVENT_HIDDEN>>
// The completion read model (runs-completion), allowlisted since SDK 1c: every field it carries is public.
type _runCompletion = NothingLeft<Unlisted<RunCompletion, typeof COMPLETION_FIELDS, []>>
type _taskCompletion = NothingLeft<Unlisted<TaskCompletion, typeof TASK_COMPLETION_FIELDS, []>>
type _completionDetail = NothingLeft<Unlisted<CompletionDetail, typeof COMPLETION_DETAIL_FIELDS, []>>
type _completionCheck = NothingLeft<Unlisted<CompletionCheckDetail, typeof COMPLETION_CHECK_FIELDS, []>>
