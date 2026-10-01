// The fifteen MCP tools (MCP design §4). Each is one Host command; `args` maps the tool's input to the
// command's arguments exactly as the CLI's parser would produce them: flag names camel-cased
// (cliArgs.ts `camel`), so `--coordinator-account` arrives as `coordinatorAccount`.
import { z } from 'zod'

export const MCP_LIMITS = { objective: 20_000, answer: 20_000, id: 200 } as const
const id = z.string().min(1).max(MCP_LIMITS.id)
const requestId = z
  .string()
  .min(1)
  .max(MCP_LIMITS.id)
  .optional()
  .describe('A client-generated id. Retrying with the same id returns the first result instead of acting twice.')

export interface ToolDef {
  name: string
  title: string
  description: string
  readOnly: boolean
  inputSchema: Record<string, z.ZodType>
  /** The Host command. create_job reads the project with `projects-get` first (server.ts). */
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
    inputSchema: {},
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
      'The agent accounts Astera holds (id, label, provider). create_job needs one as the coordinator account.',
    inputSchema: { provider: z.enum(['claude', 'codex']).optional() },
    args: (i) => (i.provider ? { agent: i.provider } : {})
  },
  // No project filter in P0: the Host's `--project` takes a folder, not a project id.
  {
    name: 'list_jobs',
    title: 'List Jobs',
    readOnly: true,
    cmd: 'jobs-list',
    description: 'Astera Jobs, each with the state of its latest Run. Filter by state.',
    inputSchema: {
      status: z.enum(['pending', 'paused', 'scheduled', 'waiting', 'running', 'completed', 'failed']).optional()
    },
    args: (i) => (i.status ? { status: i.status } : {})
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
      'Create a durable Astera Job for a project. This does not start execution. Use run_job after reviewing the returned Job id. The coordinator account runs a coordinator that plans and places the work.',
    inputSchema: {
      projectId: id,
      objective: z.string().min(1).max(MCP_LIMITS.objective),
      coordinatorAccountId: id,
      requestId
    },
    args: (i) => ({ objective: i.objective, cwd: i.cwd, coordinatorAccount: i.coordinatorAccountId })
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
    description: 'Runs, oldest first, optionally of one Job.',
    inputSchema: { jobId: id.optional() },
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
      'Stop a Run: its open workers are closed and the Run is paused. It can be resumed later from Astera or with `astera runs resume`.',
    inputSchema: { runId: id, requestId },
    args: (i) => ({ id: i.runId })
  },
  {
    name: 'list_tasks',
    title: 'List Tasks',
    readOnly: true,
    cmd: 'tasks-list',
    description: 'The Tasks of a Run, with their status and dependencies (deps).',
    inputSchema: { runId: id },
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
    description: 'Questions that block a Run until someone answers. Use answer_question with an id from here.',
    // The values questions-list accepts (command.ts `enumFilter`); any other is a 400 there.
    inputSchema: { runId: id.optional(), status: z.enum(['open', 'resolved']).optional() },
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
      'Where each Task of a Run stands in completion: checking, fixing, rechecking, reviewing, waiting-for-user, exhausted, converged or failed, with attempts and check results. Astera runs the checks and repairs; this only reads them.',
    inputSchema: { runId: id },
    args: (i) => ({ id: i.runId })
  }
]
