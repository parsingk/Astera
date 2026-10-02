// `astera mcp serve` (MCP design §4): the SDK's McpServer over stdio, every tool one Host command
// through the link. stdout is the protocol's; every diagnostic goes to stderr.
import type { Readable, Writable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { connectHost } from '../../core/host/connect'
import {
  codeForStatus,
  dataFor,
  nextStepsFor,
  refusalDetailsOf,
  type CliErrorCode
} from '../../core/orchestration/cliOutput'
import { publicFor } from '../../core/orchestration/cliPublic'
import { sanitize } from '../../core/orchestration/checkpoint'
import { cliHostTarget, runHostCommand } from '../host'
import { openHostLink, type HostLink } from './hostLink'
import { LIST_LIMIT, cursorOffset, orderAndCut } from './lists'
import { registerPrompts, registerResources } from './resources'
import { SESSION_TEXT_CAP, capSession, redactRows } from './sessionText'
import { MCP_LIMITS, TOOLS, convergenceRefusal, githubTargetRefusal, sendTextRefusal, taskTargetRefusal, type ToolDef } from './tools'

/** The fields that carry free text, from a person or an agent, at any depth. Only these go through the
 *  checkpoint's secret filter: ids, paths, cwd, worktrees and timestamps are left exactly as they are,
 *  because a filter that rewrites a path breaks the next call that uses it. The set is one for every
 *  tool on purpose: a field added for the GitHub tools (`name`, `text`, `body`...) is filtered wherever
 *  it appears, which costs at most a redacted word and never lets a secret through. */
const FREE_TEXT = new Set([
  'question',
  'resolution',
  'spec',
  'result',
  'objective',
  'error',
  'message',
  'summary',
  'answer',
  'failureSummary',
  'lastFailure',
  'title',
  'description',
  'suggestedFix',
  'retryOnceFailed',
  // The GitHub tools (MCP P2-B): an issue's and a pull request's text is written by someone else, and a
  // CI log is whatever the build printed.
  'body',
  'name',
  'workflow',
  'labels',
  'author',
  'text',
  // How It Works records (MCP P2-C): the person's request, verbatim, and every field of the agent's
  // write-up. A Job's name and a session's label are a person's text too.
  'request',
  'reason',
  'overview',
  'userVisibleChanges',
  'condition',
  'role',
  'label',
  'sourceLabel',
  'jobName',
  'outcome'
])

/** Every object in a `checks` array, at any depth, without its `outputTail`: raw validator output
 *  (up to 4000 characters of a log) does not leave through MCP. Status and exit code stay. */
const dropCheckOutput = (v: unknown, inChecks = false): unknown =>
  Array.isArray(v)
    ? v.map((x) => dropCheckOutput(x, inChecks))
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !(inChecks && k === 'outputTail'))
            .map(([k, x]) => [k, dropCheckOutput(x, k === 'checks')])
        )
      : v

/** Every string under a free-text key, however deep (an array or an object under such a key included). */
const redactAll = (v: unknown): unknown =>
  typeof v === 'string'
    ? sanitize(v)
    : Array.isArray(v)
      ? v.map(redactAll)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactAll(x)]))
        : v

/** The fields of each P1 tool's result that carry a session's or a worker's text (P1 design §4),
 *  redacted by name rather than through FREE_TEXT: a screen row, a turn or a log line is text from
 *  wherever it was printed, so every string in them, at any depth, goes through the filter. */
const OUTPUT_TEXT: Record<string, readonly string[]> = {
  get_session: ['screen', 'scrollback', 'turns', 'pending'],
  get_check_output: ['text'],
  get_task_output: ['lines']
}

const redactOutput = (tool: string, v: unknown): unknown => {
  const keys = OUTPUT_TEXT[tool]
  if (keys === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, keys.includes(k) ? redactAll(x) : x])
  )
  // A terminal's rows are visual rows: a line wider than the tab wraps onto the next, a secret with
  // it. The scrollback runs straight on into the screen, so the two are redacted as one list of rows,
  // joined back into lines first (sessionText.ts).
  const o = v as Record<string, unknown>
  if (tool === 'get_session' && Array.isArray(o.screen) && Array.isArray(o.scrollback)) {
    let scrollback = o.scrollback.map(String)
    let screen = o.screen.map(String)
    let marks =
      Array.isArray(o.scrollbackWrapped) && Array.isArray(o.screenWrapped)
        ? [...o.scrollbackWrapped, ...o.screenWrapped].map((m) => m === true)
        : undefined
    // **Rows that continue a line above the window are left out** (P1 final review I2): the line's
    // head, and the head of any secret on it, is not in the read, and a key's tail alone matches no
    // pattern. Their marks go with them, and droppedPartialRows says how many.
    let dropped = 0
    if (marks !== undefined && marks.length === scrollback.length + screen.length) {
      while (dropped < marks.length && marks[dropped]) dropped++
      if (dropped > 0) {
        const fromScrollback = Math.min(dropped, scrollback.length)
        const scrollbackMarks = marks.slice(fromScrollback, scrollback.length)
        scrollback = scrollback.slice(fromScrollback)
        screen = screen.slice(dropped - fromScrollback)
        marks = marks.slice(dropped)
        out.scrollbackWrapped = scrollbackMarks
        out.screenWrapped = marks.slice(scrollbackMarks.length)
        out.droppedPartialRows = dropped
      }
    }
    const rows = redactRows([...scrollback, ...screen], marks, typeof o.cols === 'number' ? o.cols : undefined)
    out.scrollback = rows.slice(0, scrollback.length)
    out.screen = rows.slice(scrollback.length)
  }
  // A worker's screen wraps a long line itself, so a key can run over two of these lines: each
  // adjacent pair is redacted together as well (P1 final review I3).
  if (tool === 'get_task_output' && Array.isArray(o.lines)) out.lines = redactRows(o.lines.map(String), undefined)
  return out
}

const redact = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(redact)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, FREE_TEXT.has(k) ? redactAll(x) : redact(x)]))
      : v

/** One text block: the sentence, a newline, then the structured data as JSON. No outputSchema is
 *  declared, so a client may read only `content`, and it must find the data there too. */
const textResult = (sentence: string, data: Record<string, unknown>): CallToolResult['content'] => [
  { type: 'text', text: `${sentence}\n${JSON.stringify(data)}` }
]

const errorResult = (code: CliErrorCode, message: string, cmd?: string, body?: unknown): CallToolResult => {
  // The same details the CLI's envelope carries (run.ts), so nextSteps branches the same way: a
  // request in flight points at `requests show`, a repair only the app can make gets none.
  let details = refusalDetailsOf(body)
  const nextSteps = nextStepsFor({ code, cmd, details })
  // A create_pr that failed after its push left the branch on the remote: the Host says so in `pushed`.
  const pushed = cmd === 'github-pr-create' ? (body as { pushed?: unknown } | undefined)?.pushed : undefined
  if (typeof pushed === 'boolean') details = { ...details, pushed }
  const data = { code, message, nextSteps, ...(details ? { details } : {}) }
  // **No structuredContent on an error.** Cursor validates it even when isError is set, so an error
  // carries its data only in `content`: the code/message line, then the same JSON.
  return { isError: true, content: textResult(`${code}: ${message}`, data) }
}

/** The code an error result opens its text with (`CODE: message`). */
const errorCodeOf = (r: CallToolResult): string => {
  const first = r.content[0]
  return first?.type === 'text' ? first.text.slice(0, first.text.indexOf(':')) : 'error'
}

const refusalMessage = (status: number, body: unknown): string => {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? sanitize(error) : `status ${status}`
}

/** get_session's terminal rows when no `lines` is given (P1 Global Constraints). */
const SESSION_LINES_DEFAULT = 100

/** The kind sessions-list gives a session (undefined for an id it does not have), read before the
 *  tool's own call, or that read's error. **The error is the tool's** (P1 final review M5): the
 *  client called get_session or send_message, so a refusal names it, not sessions-list. */
async function sessionKind(link: HostLink, t: ToolDef, id: unknown): Promise<string | undefined | CallToolResult> {
  const listed = await link.call('sessions-list', {})
  if ('code' in listed) return errorResult(listed.code, listed.message, t.cmd)
  if (listed.status !== 200)
    return errorResult(
      codeForStatus(listed.status),
      refusalMessage(listed.status, listed.body).replaceAll('sessions-list', t.name),
      t.cmd,
      listed.body
    )
  const session = Array.isArray(listed.body)
    ? (listed.body as Array<{ id?: unknown; kind?: unknown }>).find((x) => x.id === id)
    : undefined
  return typeof session?.kind === 'string' ? session.kind : undefined
}

/** The one read path under a tool and a resource (MCP P2-A), so they cannot drift: the Host call, the
 *  refusal mapped to its CLI code, then the public allowlist, the check-output drop and the redaction.
 *  `tool` names the tool whose result this is, for the output redaction that is per tool. */
export type HostRead =
  | { ok: true; shaped: unknown; replayed: boolean }
  | { ok: false; code: CliErrorCode; message: string; body?: unknown }

export async function hostRead(link: HostLink, cmd: string, tool: string, args: Record<string, unknown>, request?: string): Promise<HostRead> {
  const r = await link.call(cmd, args, request)
  if ('code' in r) return { ok: false, code: r.code, message: r.message }
  if (r.status < 200 || r.status >= 300)
    return { ok: false, code: codeForStatus(r.status), message: refusalMessage(r.status, r.body), body: r.body }
  return { ok: true, shaped: redactOutput(tool, redact(dropCheckOutput(publicFor(cmd, r.body)))), replayed: r.replayed === true }
}

async function runTool(link: HostLink, t: ToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
  let args = input
  // A list tool's cursor (lists.ts) is read before anything reaches the Host: one from another tool,
  // or one that is no cursor at all, is the caller's mistake.
  const offset = typeof input.cursor === 'string' ? cursorOffset(t.name, input.cursor) : 0
  if (typeof offset !== 'number') return errorResult('INVALID_ARGUMENTS', offset.error)
  const refused =
    t.name === 'create_job' || t.name === 'create_job_from_issue'
      ? convergenceRefusal(input)
      : t.name === 'create_task'
        ? taskTargetRefusal(input)
        : t.name === 'get_pr_status'
          ? githubTargetRefusal(input, 'branch')
          : t.name === 'get_ci'
            ? githubTargetRefusal(input, 'pr')
            : null
  if (refused !== null) return errorResult('INVALID_ARGUMENTS', refused)
  // create_task without an accountId runs on the Job's coordinator account, the default the
  // coordinator's own planning brief uses. jobs-get takes a Job id or a Run id.
  if (t.name === 'create_task' && input.accountId === undefined) {
    const job = await link.call('jobs-get', { id: input.jobId ?? input.runId })
    if ('code' in job) return errorResult(job.code, job.message, 'jobs-get')
    if (job.status !== 200)
      return errorResult(codeForStatus(job.status), refusalMessage(job.status, job.body), 'jobs-get', job.body)
    const account = (job.body as { coordinatorAccountId?: unknown }).coordinatorAccountId
    if (typeof account !== 'string')
      return errorResult('INVALID_ARGUMENTS', 'accountId is required: this Job has no coordinator account to default to')
    args = { ...input, accountId: account }
  }
  // create_job and list_jobs take a project id; the Host's jobs-create (`--cwd`) and jobs-list
  // (`--project`) take the project's folder. An unknown id is projects-get's own NOT_FOUND.
  // create_session (`--cwd`) and list_sessions (`--project`) the same; the Host checks again that an
  // MCP session starts in a registered project's root.
  if (
    t.name === 'create_job' ||
    t.name === 'create_session' ||
    ((t.name === 'list_jobs' || t.name === 'list_sessions') && input.projectId !== undefined)
  ) {
    const project = await link.call('projects-get', { id: input.projectId })
    if ('code' in project) return errorResult(project.code, project.message, 'projects-get')
    if (project.status !== 200)
      return errorResult(
        codeForStatus(project.status),
        refusalMessage(project.status, project.body),
        'projects-get',
        project.body
      )
    args = { ...input, projectPath: (project.body as { path: string }).path }
  }
  // create_session without an accountId runs on its provider's default account, the one
  // accounts-list marks `default: true` (claude unless another provider is given).
  if (t.name === 'create_session' && input.accountId === undefined) {
    const provider = input.provider ?? 'claude'
    const accounts = await link.call('accounts-list', { agent: provider })
    if ('code' in accounts) return errorResult(accounts.code, accounts.message, 'accounts-list')
    if (accounts.status !== 200)
      return errorResult(codeForStatus(accounts.status), refusalMessage(accounts.status, accounts.body), 'accounts-list', accounts.body)
    const found = Array.isArray(accounts.body)
      ? (accounts.body as Array<{ id?: unknown; provider?: unknown; default?: unknown }>).find(
          (a) => a.default === true && a.provider === provider
        )
      : undefined
    if (typeof found?.id !== 'string')
      return errorResult('INVALID_ARGUMENTS', `accountId is required: no ${provider} account is logged in to default to`)
    args = { ...args, accountId: found.id }
  }
  // get_session with neither bound: a terminal session reads 100 rows (P1 limits), not the Host's
  // 200, and a chat session takes no `lines` at all (the Host refuses it), so the kind is read first.
  // An id the list does not have goes to the read as it is, for its own NOT_FOUND.
  if (t.name === 'get_session' && input.lines === undefined && input.turns === undefined) {
    const kind = await sessionKind(link, t, input.sessionId)
    if (typeof kind === 'object') return kind
    if (kind === 'terminal') args = { ...input, lines: SESSION_LINES_DEFAULT }
  }
  // send_message types its text as it is (P1 final review I4): a control character is a key, and a
  // line break or a tab into a terminal is one too (Enter; Tab, a Claude Code key like Shift+Tab), so
  // only a session the list says is a chat takes them.
  if (t.name === 'send_message') {
    const text = String(input.text)
    const bad = sendTextRefusal(text)
    if (bad !== null) return errorResult('INVALID_ARGUMENTS', bad)
    if (text.includes('\n') || text.includes('\t')) {
      const kind = await sessionKind(link, t, input.sessionId)
      if (typeof kind === 'object') return kind
      if (kind !== 'chat')
        return errorResult(
          'INVALID_ARGUMENTS',
          'text holds a line break or a tab, which only a chat session takes: a terminal session takes them as keys (Enter, Tab), so send a terminal one line at a time, without tabs'
        )
    }
  }
  const read = await hostRead(link, t.cmd, t.name, t.args(args), typeof input.requestId === 'string' ? input.requestId : undefined)
  if (!read.ok) return errorResult(read.code, read.message, t.cmd, read.body)
  const { shaped, replayed } = read
  // A list tool orders its rows and cuts the page the cursor names (lists.ts); `truncated`, `total`
  // and `nextCursor` sit beside the list.
  const cut = Array.isArray(shaped)
    ? orderAndCut(t.name, shaped, typeof input.limit === 'number' ? input.limit : LIST_LIMIT.default, offset)
    : null
  const count = cut === null ? '' : cut.total === undefined ? ` (${cut.list.length})` : ` (${cut.list.length} of ${cut.total})`
  // MCP structured content is an object: a list goes under its name, as in the CLI's `data`.
  let data =
    cut === null
      ? dataFor(t.cmd, shaped)
      : {
          ...dataFor(t.cmd, cut.list),
          ...(cut.truncated ? { truncated: true, total: cut.total } : {}),
          ...(cut.nextCursor !== undefined ? { nextCursor: cut.nextCursor } : {})
        }
  // get_session holds at most SESSION_TEXT_CAP characters of text, the newest, cut after redaction.
  let note = ''
  if (t.name === 'get_session') {
    if (typeof data.droppedPartialRows === 'number')
      note = `, without its first ${data.droppedPartialRows} rows: they continue a line that starts above them, so ask for more lines to read it whole`
    const capped = capSession(data)
    if (capped.truncated) {
      data = { ...capped.data, truncated: true }
      note += `, cut to its newest ${SESSION_TEXT_CAP} characters of text: ask for fewer lines or turns to read less at once`
    }
  }
  // get_check_output pages the log only once all of it is redacted (P1 final review I1): `total`
  // and `offset` count the redacted text, so a page can never begin inside a secret.
  if (t.name === 'get_check_output' && typeof data.text === 'string') {
    const from = typeof input.offset === 'number' ? input.offset : 0
    const take = typeof input.limit === 'number' ? input.limit : MCP_LIMITS.checkOutput
    data = { ...data, total: data.text.length, offset: from, text: data.text.slice(from, from + take) }
  }
  return {
    content: textResult(`${t.title}${count}${note}${replayed ? ', replayed from the first call with this requestId' : ''}.`, data),
    structuredContent: data
  }
}

export function createMcpServer(a: { link: HostLink; version: string; log(m: string): void; debug?: boolean }): McpServer {
  const server = new McpServer(
    { name: 'astera', version: a.version },
    {
      instructions:
        'Control Astera projects, Jobs, Runs, Tasks, questions, and completion state through the local Astera Host, and, when the person allows it in Astera Settings, its sessions.'
    }
  )
  for (const t of TOOLS)
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false }
      },
      async (input: Record<string, unknown>) => {
        const result = await runTool(a.link, t, input)
        if (a.debug) a.log(`${t.name}: ${result.isError ? errorCodeOf(result) : 'ok'}`)
        return result
      }
    )
  registerResources(server, (cmd, tool, args) => hostRead(a.link, cmd, tool, args), a.log)
  registerPrompts(server)
  return server
}

/** How long the end of stdin waits for calls still in flight. */
const DRAIN_CAP_MS = 10_000

export async function serveMcp(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
  stdin?: Readable
  stdout?: Writable
  /** Test injection; without it the real link to this profile's Host is opened. */
  link?: HostLink
  /** How long the end of stdin waits for calls still in flight before closing anyway. Test injection. */
  drainCapMs?: number
}): Promise<void> {
  const log = (m: string): void => void process.stderr.write(`astera mcp: ${m}\n`)
  const stdin = a.stdin ?? process.stdin
  const target = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  const inner =
    a.link ??
    openHostLink({
      // The link opens at the first tool call, after initialize, so the hello names the client that
      // initialize named (MCP spec §29); connectHost cleans it before it is sent.
      connect: () =>
        connectHost({
          address: target.address,
          profileDir: target.profileDir,
          app: a.version,
          role: 'mcp',
          client: server.server.getClientVersion(),
          log
        }),
      startHost: async () =>
        (await runHostCommand({ cmd: 'host-start', env: a.env, platform: a.platform, home: a.home, noKeepalive: true })).ok,
      log
    })

  // **Calls in flight are counted so the end of stdin does not cut them off.** A client may write its
  // last request and close stdin at once (a pipe does), and closing the server aborts every handler
  // still running, so their answers would never be written.
  let inFlight = 0
  let idle: () => void = () => {}
  const link: HostLink = {
    async call(cmd, args, request) {
      inFlight++
      try {
        return await inner.call(cmd, args, request)
      } finally {
        inFlight--
        if (inFlight === 0) idle()
      }
    },
    close: () => inner.close()
  }

  const server = createMcpServer({ link, version: a.version, log, debug: a.env.ASTERA_MCP_LOG_LEVEL === 'debug' })
  // The transport's own onclose belongs to the SDK (Protocol.connect chains it); the server's hook
  // fires on every close, ours below or one the transport makes on a broken stream.
  const closed = new Promise<void>((resolve) => (server.server.onclose = resolve))
  await server.connect(new StdioServerTransport(stdin, a.stdout ?? process.stdout))

  const ended = new Promise<void>((resolve) => {
    stdin.once('end', resolve)
    stdin.once('close', resolve)
  })
  await Promise.race([ended, closed])
  // A turn of the event loop lets the last lines read start their handlers; then wait for their Host
  // calls, and one more turn for each answer to be written. **At most `drainCapMs`**: a call the
  // Host never answers must not keep a client's server alive after the client has gone.
  const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
  let cap: NodeJS.Timeout | undefined
  const capped = new Promise<'cap'>((r) => (cap = setTimeout(() => r('cap'), a.drainCapMs ?? DRAIN_CAP_MS)))
  const drained = (async (): Promise<'drained'> => {
    await turn()
    while (inFlight > 0) {
      await new Promise<void>((r) => (idle = r))
      await turn()
    }
    return 'drained'
  })()
  if ((await Promise.race([drained, capped])) === 'cap') log(`closing with ${inFlight} call(s) still unanswered`)
  clearTimeout(cap)
  await server.close()
  await closed
  link.close()
}
