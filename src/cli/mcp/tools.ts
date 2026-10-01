// The sixteen MCP tools (MCP design §4). Each is one Host command; `args` maps the tool's input to the
// command's arguments exactly as the CLI's parser would produce them: flag names camel-cased
// (cliArgs.ts `camel`), so `--coordinator-account` arrives as `coordinatorAccount`.
import { z } from 'zod'
import { LIST_LIMIT } from './lists'

export const MCP_LIMITS = { objective: 20_000, answer: 20_000, id: 200, cursor: 512 } as const
const id = z.string().min(1).max(MCP_LIMITS.id)
const requestId = z
  .string()
  .min(1)
  .max(MCP_LIMITS.id)
  .optional()
  .describe('A client-generated id. Retrying with the same id returns the first result instead of acting twice.')
const limit = z
  .number()
  .int()
  .min(LIST_LIMIT.min)
  .max(LIST_LIMIT.max)
  .optional()
  .describe(
    `At most this many rows (default ${LIST_LIMIT.default}). truncated: true and total mean the list is not whole: total is how many rows there are. When more rows follow, the result carries nextCursor; pass it as cursor for the next page. No nextCursor means this is the last page.`
  )
const cursor = z
  .string()
  .min(1)
  .max(MCP_LIMITS.cursor)
  .optional()
  .describe(
    'The nextCursor of a previous result of this tool, for the page after it, with the same filters. Leave it out for the first page. No nextCursor means this is the last page.'
  )

export interface ToolDef {
  name: string
  title: string
  description: string
  readOnly: boolean
  inputSchema: Record<string, z.ZodType>
  /** The Host command. create_job, and list_jobs given a projectId, read the project with
   *  `projects-get` first (server.ts) and find its folder in `projectPath`. */
  cmd: string
  args(input: Record<string, unknown>): Record<string, unknown>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    title: 'List projects',
    readOnly: true,
    cmd: 'projects-list',
    description: 'The projects registered in Astera. Use a project id with create_job.',
    inputSchema: { limit, cursor },
    args: () => ({})
  },
  {
    name: 'get_project',
    title: 'Get a project',
    readOnly: true,
    cmd: 'projects-get',
    description: 'One registered project.',
    inputSchema: { projectId: id },
    args: (i) => ({ id: i.projectId })
  },
  {
    name: 'list_accounts',
    title: 'List agent accounts',
    readOnly: true,
    cmd: 'accounts-list',
    description:
      "The agent accounts Astera holds (id, label, provider). Each provider's default account says default: true; create_job uses it when no coordinator account is given.",
    inputSchema: { provider: z.enum(['claude', 'codex']).optional(), limit, cursor },
    args: (i) => (i.provider ? { agent: i.provider } : {})
  },
  // The Host's `--project` takes a folder, so a projectId is read with projects-get first (server.ts).
  {
    name: 'list_jobs',
    title: 'List Jobs',
    readOnly: true,
    cmd: 'jobs-list',
    description: 'Astera Jobs, newest first, each with the state of its latest Run. Filter by state and by project.',
    inputSchema: {
      status: z.enum(['pending', 'paused', 'scheduled', 'waiting', 'running', 'completed', 'failed']).optional(),
      projectId: id.optional(),
      limit,
      cursor
    },
    args: (i) => ({ ...(i.status ? { status: i.status } : {}), ...(i.projectPath ? { project: i.projectPath } : {}) })
  },
  {
    name: 'get_job',
    title: 'Get a Job',
    readOnly: true,
    cmd: 'jobs-get',
    description: 'One Job and its latest Run.',
    inputSchema: { jobId: id },
    args: (i) => ({ id: i.jobId })
  },
  {
    name: 'create_job',
    title: 'Create a Job',
    readOnly: false,
    cmd: 'jobs-create',
    description:
      "Create a durable Astera Job for a project. This does not start execution. Use run_job after reviewing the returned Job id. The coordinator account runs a coordinator that plans and places the work; without coordinatorAccountId it is coordinatorProvider's default account (claude unless given).",
    inputSchema: {
      projectId: id,
      objective: z.string().min(1).max(MCP_LIMITS.objective),
      coordinatorAccountId: id.optional(),
      coordinatorProvider: z
        .enum(['claude', 'codex'])
        .optional()
        .describe("Without coordinatorAccountId, that provider's default account coordinates (default claude)."),
      requestId
    },
    // Exactly one coordinator reaches the Host: the account when given, otherwise the provider.
    args: (i) => ({
      objective: i.objective,
      cwd: i.projectPath,
      ...(i.coordinatorAccountId !== undefined
        ? { coordinatorAccount: i.coordinatorAccountId }
        : { coordinatorProvider: i.coordinatorProvider ?? 'claude' })
    })
  },
  {
    name: 'run_job',
    title: 'Run a Job',
    readOnly: false,
    cmd: 'jobs-run',
    description:
      'Start a new Run for an existing Astera Job. Returns immediately with a Run id; use get_run and get_completion to monitor progress. Configured completion checks and review policies may trigger bounded repair and recheck loops.',
    inputSchema: { jobId: id, requestId },
    args: (i) => ({ id: i.jobId })
  },
  {
    name: 'list_runs',
    title: 'List Runs',
    readOnly: true,
    cmd: 'runs-list',
    description: 'Runs, newest first, optionally of one Job.',
    inputSchema: { jobId: id.optional(), limit, cursor },
    args: (i) => (i.jobId ? { job: i.jobId } : {})
  },
  {
    name: 'get_run',
    title: 'Get a Run',
    readOnly: true,
    cmd: 'runs-get',
    description: 'One Run: its state and progress. Poll this instead of waiting; nothing here blocks.',
    inputSchema: { runId: id },
    args: (i) => ({ id: i.runId })
  },
  {
    name: 'stop_run',
    title: 'Stop a Run',
    readOnly: false,
    cmd: 'runs-stop',
    description:
      'Stop a Run: its open workers are closed and the Run is paused. Use resume_run to continue it.',
    inputSchema: { runId: id, requestId },
    args: (i) => ({ id: i.runId })
  },
  {
    name: 'resume_run',
    title: 'Resume a Run',
    readOnly: false,
    cmd: 'runs-resume',
    description: 'Resume a Run that stop_run paused. A Run that is not paused is returned as it is.',
    inputSchema: { runId: id, requestId },
    args: (i) => ({ id: i.runId })
  },
  {
    name: 'list_tasks',
    title: 'List Tasks',
    readOnly: true,
    cmd: 'tasks-list',
    description:
      'The Tasks of a Run, with their status and dependencies (deps). Each spec is cut to 160 characters, and spec_truncated says when it was; get_task has the whole spec.',
    inputSchema: { runId: id, limit, cursor },
    // `brief`: the Host bounds each spec to 160 characters and marks a cut one `spec_truncated`.
    args: (i) => ({ run: i.runId, brief: true })
  },
  {
    name: 'get_task',
    title: 'Get a Task',
    readOnly: true,
    cmd: 'tasks-get',
    description: 'One Task with its attempts and the open question on it, if any.',
    inputSchema: { taskId: id },
    args: (i) => ({ id: i.taskId })
  },
  {
    name: 'list_questions',
    title: 'List questions',
    readOnly: true,
    cmd: 'questions-list',
    description:
      'Questions that block a Run until someone answers, oldest first. Use answer_question with an id from here.',
    // The values questions-list accepts (command.ts `enumFilter`); any other is a 400 there.
    inputSchema: { runId: id.optional(), status: z.enum(['open', 'resolved']).optional(), limit, cursor },
    args: (i) => ({ ...(i.runId ? { run: i.runId } : {}), ...(i.status ? { status: i.status } : {}) })
  },
  {
    name: 'answer_question',
    title: 'Answer a question',
    readOnly: false,
    cmd: 'questions-answer',
    description:
      'Answer a blocking question raised in an Astera Run. Use list_questions first to retrieve open questions.',
    inputSchema: { questionId: id, answer: z.string().min(1).max(MCP_LIMITS.answer), requestId },
    args: (i) => ({ id: i.questionId, answer: i.answer })
  },
  {
    name: 'get_completion',
    title: 'Get completion state',
    readOnly: true,
    cmd: 'runs-completion',
    description:
      'Where each Task of a Run stands in completion: not-started, working, checking, fixing, rechecking, reviewing, waiting-for-user, exhausted, converged or failed, with attempts and check results, and a failureSummary naming each failed check, its exit code and its last output line. Astera runs the checks and repairs; this only reads them.',
    inputSchema: { runId: id },
    args: (i) => ({ id: i.runId })
  }
]
