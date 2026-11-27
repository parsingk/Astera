// `astera plugins test` (Plugin Platform V2, Phase 2 step 4b, spec E4 test): a plugin checked against Astera's contract
// without the app. A checked copy of the folder runs in the real plugin runtime and launcher (host/plugins/runtime.ts),
// against a fake Host: a call the plugin was not granted is refused as the real gate refuses it (core/host/pluginGate.ts),
// projects-list answers no project, and anything else allowed answers 404. Nothing of Astera's profile is touched; the copy,
// the runtime's own profile and a workspace for a completion check live in a temporary folder, removed after.
//
// Each check is { name, ok, detail }: `starts`, the capability's contract (each answer read by the Host's own reader, so
// what Astera would refuse fails here), `denied` (started with only what its capabilities need, it lives through its other
// calls being refused), `stops`. A restricted UI plugin's page is checked against what its panel loads instead (`page`).
// A source's or a check's calls are its real code: a job source that reads a service needs that service.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginRefusal } from '../core/host/pluginGate'
import { createEventRing } from '../core/events/eventRing'
import { logWriterFor } from '../core/log/logWriter'
import { checkAnswerOf } from '../core/orchestration/pluginChecks'
import { PLUGIN_SERVED_CAPABILITIES, capabilityPermissionProblem, parseManifest, pluginFolderName, type PluginManifest } from '../core/plugins/manifest'
import { notificationOf } from '../core/plugins/notifications'
import { coerceSetting, missingRequired, type SettingValue } from '../core/plugins/settings'
import { itemDetail, itemsPage, jobContext } from '../core/sources/answers'
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
/** What checkAnswerOf says for an answer of the wrong shape (core/orchestration/pluginChecks.ts). */
const NOT_A_CHECK_RESULT = 'the plugin answered with something that is not a check result'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A page's references to what it loads: src and href (either quote, spaces around =), and in CSS url() and @import. */
const ATTR_REFS = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const CSS_REFS = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi
const refsIn = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m.slice(1).find((g) => g !== undefined) ?? '').filter((r) => r !== '')
const isRemote = (ref: string): boolean => /^https?:/i.test(ref) || ref.startsWith('//')
const loadsNothing = (ref: string): boolean => ref.startsWith('#') || /^(?:data|blob|about|javascript|mailto):/i.test(ref)

/** The page check of a restricted UI plugin: its page and every file it loads are in the plugin (a root-relative address
 *  from the plugin's root, as its panel serves it), no inline script or handler (the panel's CSP refuses both), and
 *  nothing loaded from the network (its CSP refuses that too). Only what loads is read: script text, an SVG's namespace
 *  and binary files name addresses that load nothing. */
async function pageCheck(copy: string, ui: string): Promise<TestCheck> {
  const page = await fs.readFile(path.join(copy, ui), 'utf8')
  const found: string[] = []
  const tags = page.match(/<[^>]+>/g) ?? []
  if (tags.some((t) => /^<script\b/i.test(t) && !/\bsrc\s*=/i.test(t))) found.push('an inline script')
  if (tags.some((t) => /\son[a-z]+\s*=/i.test(t))) found.push('an inline handler')
  const read = new Set<string>()
  const follow = async (from: string, refs: string[]): Promise<void> => {
    for (const ref of refs) {
      if (loadsNothing(ref)) continue
      if (isRemote(ref)) {
        found.push(`a load from the network, ${ref}, which a panel cannot make`)
        continue
      }
      let rel: string
      try {
        rel = decodeURIComponent(ref.split(/[?#]/)[0])
      } catch {
        found.push(`${ref}, which is not an address`)
        continue
      }
      const file = rel.startsWith('/') ? path.join(copy, rel) : path.join(path.dirname(path.join(copy, from)), rel)
      const inside = path.relative(copy, file)
      if (inside.startsWith('..') || path.isAbsolute(inside) || !(await fs.stat(file).then((s) => s.isFile(), () => false))) {
        found.push(`${ref}, which is not a file in the plugin`)
        continue
      }
      const key = inside.split(path.sep).join('/')
      if (read.has(key)) continue
      read.add(key)
      // A stylesheet loads what it names; nothing else read here does
      if (/\.css$/i.test(file)) await follow(key, refsIn(await fs.readFile(file, 'utf8'), CSS_REFS))
    }
  }
  await follow(ui, [...refsIn(page, ATTR_REFS), ...(page.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).flatMap((s) => refsIn(s, CSS_REFS))])
  return found.length === 0
    ? { name: 'page', ok: true, detail: `${ui} and the ${read.size} files it loads keep to what a panel allows` }
    : { name: 'page', ok: false, detail: `${ui} holds ${found.join('; ')}` }
}

/** The settings a plugin starts with: each one's default, then what was given; and the secret values among them. */
function settingsOf(
  m: PluginManifest,
  given: Record<string, string>
): { ok: true; values: Record<string, SettingValue>; secrets: string[] } | { ok: false; problem: string } {
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
  if (missing.length > 0) return { ok: false, problem: `it needs ${missing.join(', ')}: give ${missing.length === 1 ? 'it' : 'them'} with --set <key=value>` }
  const secrets = m.settings.filter((f) => f.secret === true && typeof values[f.key] === 'string' && values[f.key] !== '').map((f) => String(values[f.key]))
  return { ok: true, values, secrets }
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

/** The plugin's own log, as the runtime writes it (what it printed, and the runtime's [host] lines about it), once
 *  everything buffered is on disk: the runtime writes it a moment later (final review I1). */
async function logLines(r: PluginRuntime, folder: string): Promise<string[]> {
  const file = r.logFile(folder)
  await logWriterFor(file).flush()
  return (await fs.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l !== '')
}

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

/** The capability's contract, asked of a running plugin; each answer read as the Host reads it. */
async function contract(
  r: PluginRuntime,
  m: PluginManifest,
  folder: string,
  ring: ReturnType<typeof createEventRing>,
  workspace: string,
  t: TestTimings
): Promise<TestCheck[]> {
  const out: TestCheck[] = []
  const ask = (method: string, params: unknown): Promise<unknown> => r.request(m.id, method, params, REQUEST_MS)
  for (const c of m.capabilities) {
    try {
      if (c === 'job-source') {
        const page = itemsPage(await ask('jobSource.list', {}))
        if (!page.ok) {
          out.push({ name: c, ok: false, detail: `listItems: ${page.problem}` })
          continue
        }
        if (page.value.items.length === 0) {
          out.push({ name: c, ok: true, detail: 'listItems answered no item, so getItem and buildJobContext were not asked' })
          continue
        }
        const id = page.value.items[0].id
        const item = itemDetail(await ask('jobSource.get', { id }))
        if (!item.ok) {
          out.push({ name: c, ok: false, detail: `getItem(${id}): ${item.problem}` })
          continue
        }
        const context = jobContext(await ask('jobSource.context', { id }))
        out.push(
          context.ok
            ? { name: c, ok: true, detail: `listed ${page.value.items.length}, read ${id} and built its Job's objective` }
            : { name: c, ok: false, detail: `buildJobContext(${id}): ${context.problem}` }
        )
      } else if (c === 'completion-check') {
        const input = { jobId: 'job_test', runId: 'run_test', taskId: 'task_test', task: { title: 'astera plugins test' }, workspace: { root: workspace } }
        try {
          const answer = checkAnswerOf(await ask('completionCheck.run', { input }))
          out.push(
            answer.summary.startsWith(NOT_A_CHECK_RESULT)
              ? { name: c, ok: false, detail: `runCheck: ${answer.summary}` }
              : { name: c, ok: true, detail: `runCheck answered ${answer.status} in an empty workspace` }
          )
        } catch (e) {
          // A check that throws is an `error` answer Astera records, with its sentence: within the contract
          if (e instanceof PluginRequestFailed && e.status === 502) out.push({ name: c, ok: true, detail: `runCheck threw, which Astera records as an error: ${e.message}` })
          else throw e
        }
      } else if (c === 'event' || c === 'notification') {
        const what = c === 'event' ? 'an event' : 'a notification'
        const before = (await logLines(r, folder)).length
        ring.append(
          [{ type: 'run.completed', jobId: 'job_test', runId: 'run_test', payload: { id: 'run_test', jobId: 'job_test', ordinal: 1, createdAt: 'T', outcome: 'completed', progress: { done: 1, total: 1 }, questionsOpen: 0 } }],
          new Date().toISOString()
        )
        await wait(t.observeMs)
        // A delivery the plugin failed is written in its log by the deliverer (host/plugins/deliverer.ts)
        const refused = (await logLines(r, folder)).slice(before).find((l) => /delivering .* failed/i.test(l))
        const s = r.status(m.id)
        out.push(
          refused !== undefined
            ? { name: c, ok: false, detail: `it failed ${what}: ${refused.replace(/^\S+\s+/, '')}` }
            : s?.status === 'running'
              ? { name: c, ok: true, detail: `took ${what} and kept running` }
              : { name: c, ok: false, detail: `it stopped after ${what}: ${s?.reason ?? s?.status ?? 'gone'}` }
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
}): Promise<{ problems: FolderProblem[] } | { plugin: { id: string; version: string }; ok: boolean; checks: TestCheck[]; warnings?: FolderProblem[] }> {
  const t = { ...TIMINGS, ...a.timings }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-test-'))
  let runtime: PluginRuntime | null = null
  let folder = ''
  try {
    const copy = path.join(work, 'plugin')
    const checked = await checkPluginFolder(a.folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES }, { keepCopy: copy })
    if (checked.problems.length > 0) return { problems: checked.problems }
    const parsed = parseManifest(JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8')))
    if (!parsed.ok) return { problems: parsed.problems.map((message) => ({ code: 'MANIFEST_INVALID' as const, message })) }
    const m = parsed.manifest
    const plugin = { id: m.id, version: m.version }
    let secrets: string[] = []
    // A secret given with --set never shows in a check, and the log a detail points to is gone once the run is over
    const clean = (s: string): string =>
      secrets.reduce((text, v) => text.split(v).join('[redacted]'), s).replace(/;\s*see astera plugins logs --id \S+/g, '')
    const done = (checks: TestCheck[]) => ({
      plugin,
      ok: checks.every((c) => c.ok),
      checks: checks.map((c) => ({ ...c, detail: clean(c.detail) })),
      ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {})
    })

    if (m.entry === undefined && m.ui === undefined) {
      // A themes-only plugin runs no code and shows no page: its themes passed the theme rules to get here (final review M4)
      const n = m.contributes.themes?.length ?? 0
      return done([{ name: 'themes', ok: true, detail: `${n} ${n === 1 ? 'theme keeps' : 'themes keep'} the theme rules: it runs no code and shows no page` }])
    }
    if (m.entry === undefined) return done(m.ui !== undefined ? [await pageCheck(copy, m.ui)] : [])

    const settings = settingsOf(m, a.settings ?? {})
    if (!settings.ok) return done([{ name: 'starts', ok: false, detail: settings.problem }])
    secrets = settings.secrets
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
    folder = pluginFolderName(m.id)
    const launch = (granted: string[]): PluginLaunch => ({
      id: m.id,
      version: m.version,
      folder,
      dir: copy,
      entry: path.join(copy, m.entry as string),
      granted,
      capabilities: m.capabilities,
      settings: settings.values,
      redact: settings.secrets
    })
    const r = runtime
    const checks: TestCheck[] = []

    r.start(launch([...m.permissions]))
    const up = await started(r, m.id, folder, t.startMs)
    checks.push(up.ok ? { name: 'starts', ok: true, detail: `running with ${m.permissions.length > 0 ? m.permissions.join(', ') : 'no permission'} granted` } : { name: 'starts', ok: false, detail: up.why })
    if (!up.ok) return done(checks)
    checks.push(...(await contract(r, m, folder, ring, workspace, t)))

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

    // Stopped as Astera stops it, from running: started again with its whole grant when an earlier check left it
    // stopped (final review M1), then asked, and ended by force only once the grace is over (the runtime logs that)
    let note = ''
    if (r.status(m.id)?.status !== 'running') {
      // restart, not start: a slot that failed starts again only with its crash count cleared
      r.restart(launch([...m.permissions]))
      const back = await started(r, m.id, folder, t.startMs)
      if (!back.ok) return done([...checks, { name: 'stops', ok: false, detail: `not checked: it did not run again (${back.why})` }])
      note = ' (started again for this check)'
    }
    const forced = async (): Promise<number> => (await logLines(r, folder)).filter((l) => /did not stop within/.test(l)).length
    const before = await forced()
    await r.stop(m.id)
    const ended = (await forced()) > before
    checks.push(
      ended
        ? { name: 'stops', ok: false, detail: `it did not stop within ${t.stopGraceMs} ms of being asked; Astera ended it${note}` }
        : { name: 'stops', ok: true, detail: `stopped when asked${note}` }
    )
    return done(checks)
  } finally {
    await runtime?.stopAll().catch(() => {})
    // Its log released before the folder goes, which Windows will not remove with a file open in it (final review M2)
    if (runtime !== null && folder !== '') await runtime.forget(folder).catch(() => {})
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}
