// The SDK's public DTOs (packages/client/src/types.ts) checked against the app's own types. For every typed object
// the SDK returns, its public fields must fit the DTO (`Fits`), and the DTO must name exactly the public field list
// (`SameKeys`), nested types included. A field added, renamed or retyped on either side breaks `npm run typecheck`
// here. Type-only: nothing in this file runs. The answers command.ts builds as records (a wait's ending and timeout, a
// stop, an answered question) carry `satisfies <DTO>` where they are built; the views' derived fields and the Task
// detail's extra fields are checked below.
import type { CheckResult, ConvergencePolicy, Gate, GitRange, Job, JobRun, JobSourceRef, Project, ReviewIssue, Task } from './types'
import type { TaskAttempt, TaskDetail } from './taskDetail'
import type { outcomeOf } from './running'
import type { progressOf } from './view'
import type { RunCompletion, TaskCompletion } from './runCompletion'
import type { CompletionCheckDetail, CompletionDetail } from './completion'
import type { JobEvent } from '../types'
import type { ScheduleRule } from '../scheduler/rule'
import type {
  CHECK_FIELDS,
  COMPLETION_CHECK_FIELDS,
  COMPLETION_DETAIL_FIELDS,
  COMPLETION_FIELDS,
  CheckResult as CheckResultDto,
  CompletionCheckDetail as CompletionCheckDetailDto,
  CompletionDetail as CompletionDetailDto,
  ConvergencePolicy as ConvergencePolicyDto,
  FOLLOW_EVENT_FIELDS,
  GitRange as GitRangeDto,
  JOB_FIELDS,
  Job as JobDto,
  JobSource as JobSourceDto,
  PROJECT_FIELDS,
  Project as ProjectDto,
  QUESTION_FIELDS,
  Question as QuestionDto,
  REVIEW_ISSUE_FIELDS,
  RUN_FIELDS,
  ReviewIssue as ReviewIssueDto,
  Run as RunDto,
  RunCompletion as RunCompletionDto,
  RunEvent as RunEventDto,
  ScheduleRule as ScheduleRuleDto,
  TASK_COMPLETION_FIELDS,
  TASK_FIELDS,
  TaskAttempt as TaskAttemptDto,
  TaskDetail as TaskDetailDto,
  JobOutcome as JobOutcomeDto,
  RunOutcome as RunOutcomeDto,
  Progress as ProgressDto,
  TaskCompletion as TaskCompletionDto,
  Task as TaskDto,
  GitHubLifecycle as GitHubLifecycleDto,
  TokenTotals as TokenTotalsDto
} from '../publicContract'
import type { GitHubLifecycleView } from '../github/view'
import type { TokenTotals } from '../types'
import type { runTokensOf, taskTokensOf } from './publicViews'

type Check<T extends true> = T
/** The app's value is accepted where the DTO is promised. */
type Fits<Internal, Dto> = [Internal] extends [Dto] ? true : false
/** The DTO names exactly these keys, no more and no fewer. */
type SameKeys<Dto, Keys extends PropertyKey> = [Exclude<keyof Dto, Keys>] extends [never]
  ? [Exclude<Keys, keyof Dto>] extends [never]
    ? true
    : false
  : false
type Fields<L extends readonly PropertyKey[]> = L[number]
/** The fields the views derive on every read (command.ts jobView, runView), not fields of the objects. */
type Derived = 'outcome' | 'progress' | 'questionsOpen'

type _project = Check<Fits<Pick<Project, Fields<typeof PROJECT_FIELDS>>, ProjectDto>>
type _projectKeys = Check<SameKeys<ProjectDto, Fields<typeof PROJECT_FIELDS>>>
type _job = Check<Fits<Pick<Job, Fields<typeof JOB_FIELDS>>, Omit<JobDto, Derived>>>
type _jobKeys = Check<SameKeys<Omit<JobDto, Derived>, Fields<typeof JOB_FIELDS>>>
/** What `runs get` adds beside the view (command.ts): how many Tasks wait on an approval, and the token totals. */
type RunGetOnly = 'waitingForApproval' | 'tokens' | 'coordinatorTokens'
type _run = Check<Fits<Pick<JobRun, Fields<typeof RUN_FIELDS>>, Omit<RunDto, Derived | RunGetOnly | 'github'>>>
type _runKeys = Check<SameKeys<Omit<RunDto, Derived | RunGetOnly | 'github'>, Fields<typeof RUN_FIELDS>>>
/** The derived github field (GitHub lifecycle) is the DTO the package promises. */
type _githubLifecycle = Check<Fits<GitHubLifecycleView, GitHubLifecycleDto>>
/** The token totals `runs get` and `tasks get` add (observe mode design §10) are the DTO the package promises. */
type _tokenTotals = Check<Fits<TokenTotals, TokenTotalsDto>>
type _tokenTotalsKeys = Check<SameKeys<TokenTotalsDto, keyof TokenTotals>>
type _runTokens = Check<Fits<ReturnType<typeof runTokensOf>, Pick<RunDto, 'tokens' | 'coordinatorTokens'>>>
type _taskTokens = Check<Fits<ReturnType<typeof taskTokensOf>, TaskDetailDto['tokens']>>
type _task = Check<Fits<Pick<Task, Fields<typeof TASK_FIELDS>>, Omit<TaskDto, 'spec_truncated'>>>
type _taskKeys = Check<SameKeys<Omit<TaskDto, 'spec_truncated'>, Fields<typeof TASK_FIELDS>>>
type _checkResult = Check<Fits<CheckResult, CheckResultDto>>
type _checkResultKeys = Check<SameKeys<CheckResultDto, Fields<typeof CHECK_FIELDS>>>
type _reviewIssue = Check<Fits<ReviewIssue, ReviewIssueDto>>
type _reviewIssueKeys = Check<SameKeys<ReviewIssueDto, Fields<typeof REVIEW_ISSUE_FIELDS>>>
type _taskAttempt = Check<Fits<TaskAttempt, TaskAttemptDto>>
type _taskAttemptKeys = Check<SameKeys<TaskAttemptDto, keyof TaskAttempt>>
type _question = Check<Fits<Gate, QuestionDto>>
type _questionKeys = Check<SameKeys<QuestionDto, Fields<typeof QUESTION_FIELDS>>>
type _runCompletion = Check<Fits<RunCompletion, RunCompletionDto>>
type _runCompletionKeys = Check<SameKeys<RunCompletionDto, Fields<typeof COMPLETION_FIELDS>>>
type _taskCompletion = Check<Fits<TaskCompletion, TaskCompletionDto>>
type _taskCompletionKeys = Check<SameKeys<TaskCompletionDto, Fields<typeof TASK_COMPLETION_FIELDS>>>
type _completionDetail = Check<Fits<CompletionDetail, CompletionDetailDto>>
type _completionDetailKeys = Check<SameKeys<CompletionDetailDto, Fields<typeof COMPLETION_DETAIL_FIELDS>>>
type _completionCheckDetail = Check<Fits<CompletionCheckDetail, CompletionCheckDetailDto>>
type _completionCheckDetailKeys = Check<SameKeys<CompletionCheckDetailDto, Fields<typeof COMPLETION_CHECK_FIELDS>>>
type _runEvent = Check<Fits<Pick<JobEvent, Fields<typeof FOLLOW_EVENT_FIELDS>>, RunEventDto>>
type _runEventKeys = Check<SameKeys<RunEventDto, Fields<typeof FOLLOW_EVENT_FIELDS>>>
type _convergencePolicy = Check<Fits<ConvergencePolicy, ConvergencePolicyDto>>
type _convergencePolicyKeys = Check<SameKeys<ConvergencePolicyDto, keyof ConvergencePolicy>>
type _gitRange = Check<Fits<GitRange, GitRangeDto>>
type _gitRangeKeys = Check<SameKeys<GitRangeDto, keyof GitRange>>
type _scheduleRule = Check<Fits<ScheduleRule, ScheduleRuleDto>>
// A Job's source (plugin Phase 4 J15; the 4a review's M10): the field the Job carries, both ways
type _jobSource = Check<Fits<JobSourceRef, JobSourceDto>>
type _jobSourceKeys = Check<SameKeys<JobSourceDto, keyof JobSourceRef>>
// The views' derived fields (command.ts derivedFor, jobView, runView): a Run's outcome, or `paused`; a Job's adds
// `pending` before its first Run.
type _runOutcome = Check<Fits<ReturnType<typeof outcomeOf> | 'paused', RunOutcomeDto>>
type _jobOutcome = Check<Fits<ReturnType<typeof outcomeOf> | 'paused' | 'pending', JobOutcomeDto>>
type _progress = Check<Fits<ReturnType<typeof progressOf>, ProgressDto>>
// The Task detail's own fields (taskDetail.ts), on top of the Task's
type _taskDetail = Check<Fits<Pick<TaskDetail, 'attempts' | 'openQuestionId'>, Pick<TaskDetailDto, 'attempts' | 'openQuestionId'>>>
