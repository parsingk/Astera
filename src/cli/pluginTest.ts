// `astera plugins test` (Plugin Platform V2, Phase 2 step 4b, spec E4 test): a plugin checked against Astera's contract
// without the app. A checked copy of the folder runs in the real plugin runtime and launcher (host/plugins/runtime.ts),
// against a fake Host: a call the plugin was not granted is refused as the real gate refuses it (core/host/pluginGate.ts),
// projects-list answers no project, and anything else allowed answers 404. Nothing of Astera's profile is touched; the copy,
// the runtime's own profile and a workspace for a completion check live in a temporary folder, removed after.
//
// Each check is { name, ok, detail }: `starts`, the capability's contract, `denied` (started with only what its
// capabilities need, it lives through its other calls being refused), `stops`. A restricted UI plugin's page is checked
// against what its guest allows instead (`page`).
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginRefusal } from '../core/host/pluginGate'
import { createEventRing } from '../core/events/eventRing'
import { PLUGIN_SERVED_CAPABILITIES, capabilityPermissionProblem, parseManifest, pluginFolderName, type PluginManifest } from '../core/plugins/manifest'
import { notificationOf } from '../core/plugins/notifications'
import { coerceSetting, missingRequired, type SettingValue } from '../core/plugins/settings'
import { checkPluginFolder, type FolderProblem } from '../host/plugins/folderCheck'
import { PluginRequestFailed, createPluginRuntime, type PluginLaunch, type PluginRuntime } from '../host/plugins/runtime'

export interface TestCheck {
  name: string
  ok: boolean
  detail: string
}

export interface TestTimings {
  /** How long a plugin has to start. */
  startMs: number
  /** How long it has to stop once asked, before it is ended. */
  stopGraceMs: number
  /** How long it is watched to live after an event, or with calls refused. */
  observeMs: number
}
const TIMINGS: TestTimings = { startMs: 15_000, stopGraceMs: 5_000, observeMs: 2_000 }
const REQUEST_MS = 15_000

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The page check of a restricted UI plugin: its page and every file it names are in the plugin, no inline script or
 *  handler (the guest's CSP refuses both), no remote address (its CSP refuses the network). */
async function pageCheck(copy: string, ui: string): Promise<TestCheck> {
  const page = await fs.readFile(path.join(copy, ui), 'utf8')
  const found: string[] = []
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(page)) found.push('an inline script')
  if (/\son[a-z]+\s*=/i.test(page)) found.push('an inline handler')
  const named = [...page.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1])
  const texts = [page]
  for (const ref of named) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue
    const file = path.join(path.dirname(path.join(copy, ui)), ref.split(/[?#]/)[0])
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text === null) found.push(`${ref}, which is not a file in the plugin`)
    else texts.push(text)
  }
  const remote = [...new Set(texts.flatMap((t) => [...t.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'()<>]*/gi)].map((m) => m[0])))]
  for (const r of remote) found.push(`a remote address, ${r}, which its page cannot reach`)
  return found.length === 0
    ? { name: 'page', ok: true, detail: `${ui} and the ${named.length} files it names keep to what a panel allows` }
    : { name: 'page', ok: false, detail: `${ui} holds ${found.join('; ')}` }
}

/** The settings a plugin starts with: each one's default, then what was given. */
function settingsOf(m: PluginManifest, given: Record<string, string>): { ok: true; values: Record<string, SettingValue> } | { ok: false; problem: string } {
  const values: Record<string, SettingValue> = {}
  for (const f of m.settings) if (f.default !== undefined) values[f.key] = f.default
  for (const [key, raw] of Object.entries(given)) {
    const field = m.settings.find((f) => f.key === key)
    if (!field) return { ok: false, problem: `${key} is not one of its settings` }
    const v = coerceSetting(field, raw)
    if (!v.ok) return { ok: false, problem: v.problem }
    values[key] = v.value
  }
  const missing = missingRequired(m.settings, (k) => Object.hasOwn(values, k), (k) => values[k])
  return missing.length > 0 ? { ok: false, problem: `it needs ${missing.join(', ')}: give ${missing.length === 1 ? 'it' : 'them'} with --set <key=value>` } : { ok: true, values }
}

/** The fewest of what it asks for that its capabilities still need: what `denied` starts it with. */
function leastGrant(m: PluginManifest): string[] {
  let grant = [...m.permissions] as string[]
  for (const p of m.permissions) {
    const rest = grant.filter((g) => g !== p)
    if (capabilityPermissionProblem(m.capabilities, rest as never) === null) grant = rest
  }
  return grant
}

/** The plugin's own log, as the runtime writes it (what it printed, and the runtime's [host] lines about it). */
const logLines = async (r: PluginRuntime, folder: string): Promise<string[]> =>
  (await fs.readFile(r.logFile(folder), 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l !== '')

/** Waits until the plugin runs, fails, or the time is up; says how it went and, on a failure, its last log lines. */
async function started(r: PluginRuntime, id: string, folder: string, ms: number): Promise<{ ok: boolean; why: string }> {
  const until = Date.now() + ms
  const tail = async (): Promise<string> => {
    const lines = await logLines(r, folder)
    return lines.length > 0 ? `; its log ends: ${lines.slice(-3).join(' | ')}` : ''
  }
  for (;;) {
    const s = r.status(id)
    if (s?.status === 'running') return { ok: true, why: '' }
    if (s?.status === 'failed' || (s?.status === 'stopped' && s.reason !== undefined)) return { ok: false, why: `${s.reason ?? s.status}${await tail()}` }
    if (Date.now() > until) return { ok: false, why: `it was not running after ${Math.round(ms / 1000)} s${await tail()}` }
    await wait(50)
  }
}

/** The capability's contract, asked of a running plugin. */
async function contract(r: PluginRuntime, m: PluginManifest, ring: ReturnType<typeof createEventRing>, workspace: string, t: TestTimings): Promise<TestCheck[]> {
  const out: TestCheck[] = []
  const ask = (method: string, params: unknown): Promise<unknown> => r.request(m.id, method, params, REQUEST_MS)
  for (const c of m.capabilities) {
    try {
      if (c === 'job-source') {
        const list = await ask('jobSource.list', {})
        const items = isObject(list) && Array.isArray(list.items) ? list.items : null
        if (items === null || !items.every((i) => isObject(i) && typeof i.id === 'string' && typeof i.title === 'string')) {
          out.push({ name: c, ok: false, detail: 'listItems must answer { items: [{ id, title }] }' })
          continue
        }
        if (items.length === 0) {
          out.push({ name: c, ok: true, detail: 'listItems answered no item, so getItem and buildJobContext were not asked' })
          continue
        }
        const id = (items[0] as { id: string }).id
        const item = await ask('jobSource.get', { id })
        if (!isObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string') {
          out.push({ name: c, ok: false, detail: `getItem(${id}) must answer { id, title }` })
          continue
        }
        const context = await ask('jobSource.context', { id })
        out.push(
          isObject(context) && typeof context.objective === 'string' && context.objective.trim() !== ''
            ? { name: c, ok: true, detail: `listed ${items.length}, read ${id} and built its Job's objective` }
            : { name: c, ok: false, detail: `buildJobContext(${id}) must answer { objective }` }
        )
      } else if (c === 'completion-check') {
        const input = { jobId: 'job_test', runId: 'run_test', taskId: 'task_test', task: { title: 'astera plugins test' }, workspace: { root: workspace } }
        try {
          const answer = await ask('completionCheck.run', { input })
          const ok = isObject(answer) && ['passed', 'failed', 'error'].includes(String(answer.status)) && (answer.summary === undefined || typeof answer.summary === 'string')
          out.push(
            ok
              ? { name: c, ok: true, detail: `runCheck answered ${String((answer as Record<string, unknown>).status)} in an empty workspace` }
              : { name: c, ok: false, detail: 'runCheck must answer { status: passed, failed or error, summary? }' }
          )
        } catch (e) {
          // A check that throws is an `error` answer Astera records, with its sentence: within the contract
          if (e instanceof PluginRequestFailed && e.status === 502) out.push({ name: c, ok: true, detail: `runCheck threw, which Astera records as an error: ${e.message}` })
          else throw e
        }
      } else if (c === 'event' || c === 'notification') {
        ring.append([{ type: 'run.completed', jobId: 'job_test', runId: 'run_test', payload: { id: 'run_test', jobId: 'job_test', ordinal: 1, createdAt: 'T', outcome: 'completed', progress: { done: 1, total: 1 }, questionsOpen: 0 } }], new Date().toISOString())
        await wait(t.observeMs)
        const s = r.status(m.id)
        out.push(
          s?.status === 'running'
            ? { name: c, ok: true, detail: `still running ${t.observeMs} ms after ${c === 'event' ? 'an event' : 'a notification'} was offered` }
            : { name: c, ok: false, detail: `it stopped after ${c === 'event' ? 'an event' : 'a notification'}: ${s?.reason ?? s?.status ?? 'gone'}` }
        )
      }
    } catch (e) {
      out.push({ name: c, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

export async function testPlugin(a: {
  folder: string
  version: string
  /** The plugin launcher: plugin-host.js beside the CLI, or a test's bundle. */
  launcher: string
  settings?: Record<string, string>
  timings?: Partial<TestTimings>
}): Promise<{ problems: FolderProblem[] } | { plugin: { id: string; version: string }; ok: boolean; checks: TestCheck[] }> {
  const t = { ...TIMINGS, ...a.timings }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-test-'))
  let runtime: PluginRuntime | null = null
  try {
    const copy = path.join(work, 'plugin')
    const checked = await checkPluginFolder(a.folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES }, { keepCopy: copy })
    if (checked.problems.length > 0) return { problems: checked.problems }
    const parsed = parseManifest(JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8')))
    if (!parsed.ok) return { problems: parsed.problems.map((message) => ({ code: 'MANIFEST_INVALID' as const, message })) }
    const m = parsed.manifest
    const plugin = { id: m.id, version: m.version }
    const done = (checks: TestCheck[]) => ({ plugin, ok: checks.every((c) => c.ok), checks })

    if (m.entry === undefined) return done(m.ui !== undefined ? [await pageCheck(copy, m.ui)] : [])

    const settings = settingsOf(m, a.settings ?? {})
    if (!settings.ok) return done([{ name: 'starts', ok: false, detail: settings.problem }])
    const workspace = path.join(work, 'workspace')
    await fs.mkdir(workspace)
    const ring = createEventRing({ boot: 'aaaaaaaaaaaa', retainEvents: 100, retainChars: 100_000 })
    runtime = createPluginRuntime({
      profileDir: path.join(work, 'profile'),
      exec: process.execPath,
      launcher: a.launcher,
      env: process.env,
      host: () => ({ version: a.version, pid: process.pid, startedAt: new Date().toISOString(), features: ['orch', 'requests', 'events'] }),
      orch: {
        call: (async (c: { cmd: string; from?: { plugin?: { id: string; granted: ReadonlySet<string> } } }) => {
          const refusal = pluginRefusal(c.cmd, c.from?.plugin)
          if (refusal !== null) return refusal
          if (c.cmd === 'projects-list') return { status: 200, body: [] }
          return { status: 404, body: { error: `${c.cmd} is not answered by plugins test` } }
        }) as never
      },
      log: () => {},
      timings: { startMs: t.startMs, stopGraceMs: t.stopGraceMs, backoffMs: [100, 100], stableMs: 60_000, failAfter: 1 },
      events: ring,
      delivery: { retryFirstMs: 50, retryMaxMs: 50 },
      notify: (e) => notificationOf(e, { lang: 'en', objectiveOf: () => 'astera plugins test' })
    })
    const launch = (granted: string[]): PluginLaunch => ({
      id: m.id,
      version: m.version,
      folder: pluginFolderName(m.id),
      dir: copy,
      entry: path.join(copy, m.entry as string),
      granted,
      capabilities: m.capabilities,
      settings: settings.values,
      redact: []
    })
    const r = runtime
    const folder = pluginFolderName(m.id)
    const checks: TestCheck[] = []

    r.start(launch([...m.permissions]))
    const up = await started(r, m.id, folder, t.startMs)
    checks.push(up.ok ? { name: 'starts', ok: true, detail: `running with ${m.permissions.length > 0 ? m.permissions.join(', ') : 'no permission'} granted` } : { name: 'starts', ok: false, detail: up.why })
    if (!up.ok) return done(checks)
    checks.push(...(await contract(r, m, ring, workspace, t)))

    // Calls refused: started again with only what its capabilities need
    const least = leastGrant(m)
    const withheld = m.permissions.filter((p) => !least.includes(p))
    if (withheld.length > 0) {
      await r.stop(m.id)
      r.start(launch(least))
      const again = await started(r, m.id, folder, t.startMs)
      if (again.ok) await wait(t.observeMs)
      const s = r.status(m.id)
      checks.push(
        again.ok && s?.status === 'running'
          ? { name: 'denied', ok: true, detail: `still running ${t.observeMs} ms with ${withheld.join(', ')} withheld, its calls needing ${withheld.length === 1 ? 'it' : 'them'} refused` }
          : { name: 'denied', ok: false, detail: `with ${withheld.join(', ')} withheld it did not keep running: ${again.ok ? (s?.reason ?? s?.status ?? 'gone') : again.why}` }
      )
    } else checks.push({ name: 'denied', ok: true, detail: 'it asks for no permission beyond what its capabilities need, so nothing was withheld' })

    // Stopped as Astera stops it: asked, and ended by force only once the grace is over (the runtime says so in its log)
    const forced = async (): Promise<number> => (await logLines(r, folder)).filter((l) => /did not stop within/.test(l)).length
    const before = await forced()
    await r.stop(m.id)
    const ended = (await forced()) > before
    checks.push(
      ended
        ? { name: 'stops', ok: false, detail: `it did not stop within ${t.stopGraceMs} ms of being asked; Astera ended it` }
        : { name: 'stops', ok: true, detail: `stopped when asked` }
    )
    return done(checks)
  } finally {
    await runtime?.stopAll().catch(() => {})
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
