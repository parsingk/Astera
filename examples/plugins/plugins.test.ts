// The sample plugins as a person uses them (plugins 2f, plugin Phase 3): each manifest is one Astera installs, each
// plugin imports only Node's own modules so its folder installs as it is, it typechecks against the SDK's types, and it
// runs in the real plugin runtime (the launcher bundled, a process of its own) from a copy made as a folder install
// makes it, handed the events of a real event log as the Host hands them.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { removeFixture } from '../../src/core/testFixtures'
import { parseManifest } from '../../src/core/plugins/manifest'
import { PluginRequestFailed, createPluginRuntime, type PluginRuntime } from '../../src/host/plugins/runtime'
import { copyPluginFolder } from '../../src/host/plugins/copyFolder'
import { createEventRing, type EventRing } from '../../src/core/events/eventRing'
import type { EventDraft } from '../../src/core/orchestration/publicEvents'
import { itemSplitter } from './debug-leftovers/index.mjs'
import type { AsteraEvent } from '../../src/core/publicContract'
import { bundleLauncher } from '../../src/pluginHost/testkit'
import { notificationOf } from '../../src/core/plugins/notifications'
import { runTsc } from '../../packages/client/test/typecheck'
import { gitSync, tempDir } from '../../src/core/worktrees/testRepo'
import { hostCompletionChecks } from '../../src/host/completionChecks'
import { pluginCheckText } from '../../src/core/orchestration/pluginChecks'

const here = path.dirname(fileURLToPath(import.meta.url))
const NOTIFIER = path.join(here, 'webhook-notifier')
const ID = 'astera-webhook-notifier'
const DISCORD = path.join(here, 'discord-notifier')
const DISCORD_ID = 'astera-discord-notifier'

let work: string
let launcher: string
/** The sample as `astera plugins install --path` copies it (2f final review m10): it runs from there, not the repo. */
let installed: string
let discordInstalled: string
beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'astera-plugin samples '))
  launcher = await bundleLauncher(work)
  installed = path.join(work, 'installed', ID)
  await copyPluginFolder(NOTIFIER, installed)
  discordInstalled = path.join(work, 'installed', DISCORD_ID)
  await copyPluginFolder(DISCORD, discordInstalled)
}, 60_000)
afterAll(async () => {
  await removeFixture(work)
})
const started: PluginRuntime[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const r of started.splice(0)) await r.stopAll()
  for (const s of servers.splice(0)) await new Promise((res) => s.close(() => res(undefined)))
})

// 45 s: starts and restarts of a real plugin process under the full suite, as the runtime rig's (load-sensitive tests,
// 2026-10-14, final review I2)
const until = <T>(f: () => T, timeout = 45_000): Promise<T> => vi.waitFor(f, { timeout, interval: 25 })

/** A webhook that answers with `statuses` in turn (200 once they run out), each with its body when it has one, and
 *  keeps what it was sent. */
async function webhook(statuses: Array<number | { status: number; body: string }> = []) {
  const bodies: unknown[] = []
  const posts: { text: string; signature: string | undefined }[] = []
  /** When each request arrived, answered or refused */
  const at: number[] = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.setEncoding('utf8').on('data', (c: string) => (text += c))
    req.on('end', () => {
      at.push(Date.now())
      const next = statuses.shift() ?? 200
      const status = typeof next === 'number' ? next : next.status
      if (status === 200) {
        bodies.push(JSON.parse(text))
        const signature = req.headers['x-astera-signature']
        posts.push({ text, signature: typeof signature === 'string' ? signature : undefined })
      }
      res.writeHead(status, typeof next === 'number' ? {} : { 'content-type': 'application/json' })
      res.end(typeof next === 'number' ? undefined : next.body)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/T0/B0/secret-part`, bodies, posts, at }
}

const RUN = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T', outcome: 'completed', progress: { done: 2, total: 2 }, questionsOpen: 0 }

/** Appends one event to the log, as a commit would, and answers it as the log holds it. */
const append = (ring: EventRing, draft: EventDraft): AsteraEvent => ring.append([draft], 'T')[0].event
const completed = (ring: EventRing): AsteraEvent => append(ring, { type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN })
const failed = (ring: EventRing): AsteraEvent => append(ring, { type: 'run.failed', jobId: 'job_1', runId: 'run_1', payload: { ...RUN, outcome: 'failed' } })

/** The plugin runtime with a Host that answers no command (the sample asks for none) and an event log of its own,
 *  holding at most `retain` events. */
function runtime(o: { failAfter?: number; retain?: number; env?: NodeJS.ProcessEnv } = {}) {
  const ring = createEventRing({ boot: 'aaaaaaaaaaaa', retainEvents: o.retain ?? 2000, retainChars: 1 << 23 })
  const r = createPluginRuntime({
    profileDir: path.join(work, `profile ${started.length + Math.random()}`),
    exec: process.execPath,
    launcher,
    env: o.env ?? process.env,
    host: () => ({ version: '9.9.9', pid: process.pid, startedAt: 'T', features: ['orch', 'requests', 'events'] }),
    orch: { call: (async (a: { cmd: string }) => ({ status: 404, body: { error: `no ${a.cmd} here` } })) as never },
    log: () => {},
    // The runtime rig's budgets (src/host/plugins/runtime.test.ts): a start is a process spawn, and a crash counts as
    // quick within the start's own time under load
    timings: { startMs: 60_000, stopGraceMs: 2_000, backoffMs: [50, 50], stableMs: 30_000, failAfter: o.failAfter ?? 3 },
    events: ring,
    // Astera's own retries, quick: a failed post is handed over again
    delivery: { retryFirstMs: 50, retryMaxMs: 50 },
    // Worded as the Host words them, in English, every Job's objective "Ship it"
    notify: (e) => notificationOf(e, { lang: 'en', objectiveOf: () => 'Ship it' })
  })
  started.push(r)
  return { r, ring }
}

const launch = (settings: Record<string, string | number | boolean>, redact: string[]) => ({
  id: ID,
  version: '0.2.0',
  folder: ID,
  dir: installed,
  entry: path.join(installed, 'index.mjs'),
  granted: ['events.subscribe'],
  capabilities: ['event' as const],
  settings,
  redact
})
const logOf = (r: PluginRuntime): string => (existsSync(r.logFile(ID)) ? readFileSync(r.logFile(ID), 'utf8') : '')

/** Starts the sample and waits until it runs, so the events appended after it are its to post. */
async function running(r: PluginRuntime, settings: Record<string, string | number | boolean>, redact: string[]): Promise<void> {
  r.start(launch(settings, redact))
  await until(() => expect(r.status(ID)?.status).toBe('running'))
}

describe('the webhook notifier sample', () => {
  it('is a manifest Astera installs: an event plugin with the one permission that needs, a secret webhook URL, and a choice', () => {
    const read = parseManifest(JSON.parse(readFileSync(path.join(NOTIFIER, 'package.json'), 'utf8')))
    if (!read.ok) throw new Error(read.problems.join('; '))
    expect(read.manifest).toMatchObject({ id: ID, apiVersion: '1', entry: 'index.mjs', permissions: ['events.subscribe'], capabilities: ['event'] })
    expect(read.manifest.minAsteraVersion).toBeUndefined()
    expect(read.manifest.settings).toEqual([
      expect.objectContaining({ key: 'webhookUrl', type: 'string', secret: true, required: true }),
      expect.objectContaining({ key: 'signingSecret', type: 'string', secret: true, required: false }),
      expect.objectContaining({ key: 'onlyProblems', type: 'boolean', default: false, required: false })
    ])
  })

  it('imports only Node’s own modules, so its folder installs as it is', () => {
    const code = readFileSync(path.join(NOTIFIER, 'index.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // `from 'x'`, `import 'x'` and `import('x')`, in any quotes (2f final review m10)
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(specifiers).toContain('node:crypto')
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([])
  })

  it('typechecks against the plugin SDK’s types', () => {
    expect(runTsc(path.join(here, 'tsconfig.json'))).toBe('')
  }, 60_000)

  // 5e (performance review): a webhook that was deleted or forbids posting refuses every try; the event is left, said
  // once, and the next one goes, rather than holding the rest for an hour
  it('leaves an event a webhook refuses for good, says why, and posts the next one', async () => {
    const hook = await webhook([410])
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: false }, [hook.url])
    const first = completed(ring)
    const second = completed(ring)
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toMatchObject({ event: { id: second.id } })
    await until(() => expect(logOf(r)).toContain(`[warn] the webhook refused run.completed ${first.id} (410): it is not posted`))
    expect(logOf(r)).not.toContain('failed (try')
  }, 90_000)

  // 5e final review M9: a rate limit or a timeout is not a refusal for good: Astera hands the event over again
  it('is handed an event again when the webhook asks it to wait (429)', async () => {
    const hook = await webhook([429])
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: false }, [hook.url])
    const e = completed(ring)
    await until(() => expect(hook.bodies).toHaveLength(1))
    // The log is written after the post: the line that says it was posted comes after the failure's
    await until(() => expect(logOf(r)).toContain(`posted run.completed ${e.id}`))
    expect(logOf(r)).toContain(`delivering run.completed ${e.id} failed (try 1): onEvent threw: the webhook answered 429`)
    expect(logOf(r)).not.toContain('refused')
  }, 90_000)

  it('posts a completed Run to the webhook, is handed it again by Astera when a post fails, and keeps the URL out of its log', async () => {
    const hook = await webhook([500])
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: false }, [hook.url])
    const e = completed(ring)
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toEqual({ text: 'Run run_1 of job job_1 completed (2 of 2 tasks)', event: e })
    await until(() => expect(logOf(r)).toContain(`posted run.completed ${e.id}`))
    expect(logOf(r)).toContain(`delivering run.completed ${e.id} failed (try 1): onEvent threw: the webhook answered 500`)
    expect(logOf(r)).not.toContain('secret-part')
    // No signing secret, no signature
    expect(hook.posts[0].signature).toBeUndefined()
  }, 90_000)

  // Spec §17: a webhook plugin's settings are its URL, a secret, event filters and a retry policy
  it('signs each post with the signing secret when one is set, so a service of your own can tell it came from here', async () => {
    const hook = await webhook()
    const key = 'shh-signing-key'
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, signingSecret: key, onlyProblems: false }, [hook.url, key])
    completed(ring)
    await until(() => expect(hook.posts).toHaveLength(1))
    const { text, signature } = hook.posts[0]
    expect(signature).toBe(`sha256=${createHmac('sha256', key).update(text).digest('hex')}`)
  }, 90_000)

  it('leaves out completed Runs when told to post only problems', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: true }, [hook.url])
    completed(ring)
    const e = failed(ring)
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toEqual({ text: 'Run run_1 of job job_1 failed', event: e })
  }, 90_000)

  // Plugin Phase 3: an event plugin is handed what happened while it was stopped
  it('posts what happened while it was stopped once it runs again', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    const settings = { webhookUrl: hook.url, onlyProblems: false }
    await running(r, settings, [hook.url])
    await r.stop(ID)
    const e = failed(ring)
    await running(r, settings, [hook.url])
    await until(() => expect(hook.bodies).toEqual([{ text: 'Run run_1 of job job_1 failed', event: e }]))
  }, 90_000)

  it('says so when events were lost while it was stopped, then posts the ones the log still holds', async () => {
    const hook = await webhook()
    const { r, ring } = runtime({ retain: 2 })
    const settings = { webhookUrl: hook.url, onlyProblems: false }
    completed(ring)
    await running(r, settings, [hook.url])
    await r.stop(ID)
    const [, second, third] = [failed(ring), failed(ring), failed(ring)]
    await running(r, settings, [hook.url])
    await until(() => expect(hook.bodies).toHaveLength(3))
    expect(hook.bodies[0]).toEqual({ text: 'Some Astera events were lost (older than the Host keeps): look in the app.', event: { type: 'gap' } })
    expect(hook.bodies.slice(1)).toEqual([expect.objectContaining({ event: second }), expect.objectContaining({ event: third })])
  }, 90_000)

  // 2f final review I3: the runtime calls any exit it asked for a stop, so the log is what tells a quiet stop from one
  // that wrote an error and exited with a failure
  it('stops quietly when Astera stops it', async () => {
    const hook = await webhook()
    const { r } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: false }, [hook.url])
    await r.stop(ID)
    expect(r.status(ID)?.status).toBe('stopped')
    // The log is written a moment after the status changes
    await until(() => expect(logOf(r)).toContain('[host] stopped'))
    const log = logOf(r)
    expect(log).toContain('[host] exited with code 0')
    expect(log).not.toContain('[error]')
    expect(log).not.toContain('did not stop within')
  }, 90_000)

  // 2f final review I2: configuring a failed plugin does not start it, so the message says what does
  it('says how to start it again when its webhook URL is not one', async () => {
    const { r } = runtime({ failAfter: 1 })
    r.start(launch({ webhookUrl: 'hooks.example.com/T0', onlyProblems: false }, ['hooks.example.com/T0']))
    await until(() => expect(r.status(ID)?.status).toBe('failed'))
    await until(() => expect(logOf(r)).toContain('[host] failed: '))
    expect(logOf(r)).toMatch(/astera plugins configure.*astera plugins enable/)
  }, 90_000)

  // 2f final review m12: Slack reads <...> as a mention or a link, so <!channel> in a title would ping a channel
  it('escapes what Slack reads as markup in the text it posts, and leaves the event as it is', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    await running(r, { webhookUrl: hook.url, onlyProblems: false }, [hook.url])
    const payload = { taskId: 'task_1', title: '<!channel> & <b>', state: 'exhausted', attempt: 3, maxAttempts: 3, detail: null, failureSummary: null, lastFailure: 'a < b' }
    const e = append(ring, { type: 'completion.exhausted', jobId: 'job_1', runId: 'run_1', taskId: 'task_1', payload })
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toEqual({ text: '"&lt;!channel&gt; &amp; &lt;b&gt;" ran out of repairs: a &lt; b', event: e })
  }, 90_000)
})

describe('the Discord notifier sample', () => {
  const settingsOf = (url: string, skip = 'session.account_switched') => ({ webhookUrl: url, skip })
  const discordLaunch = (settings: Record<string, string | number | boolean>, redact: string[]) => ({
    id: DISCORD_ID,
    version: '0.1.0',
    folder: DISCORD_ID,
    dir: discordInstalled,
    entry: path.join(discordInstalled, 'index.mjs'),
    granted: ['events.subscribe'],
    capabilities: ['notification' as const],
    settings,
    redact
  })
  const discordLog = (r: PluginRuntime): string => (existsSync(r.logFile(DISCORD_ID)) ? readFileSync(r.logFile(DISCORD_ID), 'utf8') : '')
  async function discord(r: PluginRuntime, settings: Record<string, string | number | boolean>, redact: string[]): Promise<void> {
    r.start(discordLaunch(settings, redact))
    await until(() => expect(r.status(DISCORD_ID)?.status).toBe('running'))
  }
  const now = (): string => new Date().toISOString()
  const SESSION = { id: 's1', kind: 'terminal', title: 'Fix the build', cwd: '/w/proj' }

  it('is a manifest Astera installs: a notification plugin with the permission that needs, a secret webhook URL, and the kinds to leave out', () => {
    const read = parseManifest(JSON.parse(readFileSync(path.join(DISCORD, 'package.json'), 'utf8')))
    if (!read.ok) throw new Error(read.problems.join('; '))
    expect(read.manifest).toMatchObject({ id: DISCORD_ID, apiVersion: '1', entry: 'index.mjs', permissions: ['events.subscribe'], capabilities: ['notification'] })
    expect(read.manifest.settings).toEqual([
      expect.objectContaining({ key: 'webhookUrl', type: 'string', secret: true, required: true }),
      expect.objectContaining({ key: 'skip', type: 'string', default: 'session.account_switched', required: false })
    ])
  })

  it('imports only Node’s own modules, so its folder installs as it is', () => {
    const code = readFileSync(path.join(DISCORD, 'index.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(specifiers.filter((x) => !x.startsWith('node:'))).toEqual([])
  })

  it('posts a notification as an embed coloured by its level, with its title, body, time and kind', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    const at = now()
    ring.append([{ type: 'run.failed', jobId: 'job_1', runId: 'run_1', payload: { ...RUN, outcome: 'failed' } }], at)
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toEqual({
      embeds: [{ title: 'Ship it', description: 'Run 1 failed (2 of 2 Tasks done).', color: 0xef4444, timestamp: at, footer: { text: 'run.failed' } }],
      allowed_mentions: { parse: [] }
    })
    await until(() => expect(discordLog(r)).toContain('posted run.failed ev_aaaaaaaaaaaa_1'))
    expect(discordLog(r)).not.toContain('secret-part')
  }, 90_000)

  // Review Focus 2: text from a question or a session is posted as it is, and Discord is told to ping nobody
  it('pings nobody, whatever the text holds', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    const question = { id: 'q1', runId: 'run_1', taskId: 't1', question: '@everyone <@123> which branch?', status: 'open', createdAt: 'T' }
    ring.append([{ type: 'question.created', jobId: 'job_1', runId: 'run_1', taskId: 't1', payload: question }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toMatchObject({ embeds: [{ description: 'Waiting for an answer: @everyone <@123> which branch?', color: 0x3b82f6 }], allowed_mentions: { parse: [] } })
  }, 90_000)

  it('leaves out the kinds its skip setting names, account switches by default', async () => {
    const hook = await webhook()
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    ring.append([{ type: 'session.account_switched', sessionId: 's1', payload: { session: SESSION, accountLabel: 'work' } }], now())
    ring.append([{ type: 'session.input_needed', sessionId: 's1', payload: { session: SESSION, prompt: 'permission' } }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toMatchObject({ embeds: [{ title: 'Fix the build', description: 'Waiting for permission.', footer: { text: 'session.input_needed' } }] })
    const other = await webhook()
    const second = runtime()
    await discord(second.r, settingsOf(other.url, ' run.completed , session.input_needed '), [other.url])
    second.ring.append([{ type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN }], now())
    second.ring.append([{ type: 'session.input_needed', sessionId: 's1', payload: { session: SESSION, prompt: null } }], now())
    second.ring.append([{ type: 'session.account_switched', sessionId: 's1', payload: { session: SESSION, accountLabel: 'work' } }], now())
    await until(() => expect(other.bodies).toHaveLength(1))
    expect(other.bodies[0]).toMatchObject({ embeds: [{ description: 'Continuing on the work account.' }] })
  }, 90_000)

  // 5e (performance review): a short wait Discord asks for is waited out once, inside the call
  it('waits out a short rate limit once and posts, rather than failing the try', async () => {
    const hook = await webhook([{ status: 429, body: '{"message":"You are being rate limited.","retry_after":0.2,"global":false}' }])
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    ring.append([{ type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    await until(() => expect(discordLog(r)).toContain('posted run.completed'))
    expect(discordLog(r)).not.toContain('failed (try')
    // It waited what Discord asked before posting again (5e final review M8)
    expect(hook.at[1] - hook.at[0]).toBeGreaterThanOrEqual(180)
  }, 90_000)

  it('is sent a notification again by Astera when Discord asks it to wait long, and says how long Discord asked', async () => {
    const hook = await webhook([{ status: 429, body: '{"message":"You are being rate limited.","retry_after":60,"global":false}' }])
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    ring.append([{ type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    await until(() => expect(discordLog(r)).toContain('failed (try 1): send threw: Discord answered 429; it asks to wait 60 s'))
  }, 90_000)

  // 5e (performance review): a webhook Discord deleted (404) refuses every try, as a malformed payload does
  it('leaves a notification whose webhook is gone, says why, and posts the next one', async () => {
    const hook = await webhook([{ status: 404, body: '{"message":"Unknown Webhook","code":10015}' }])
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    ring.append([{ type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN }], now())
    ring.append([{ type: 'run.failed', jobId: 'job_1', runId: 'run_1', payload: { ...RUN, outcome: 'failed' } }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    await until(() => expect(discordLog(r)).toContain('[warn] Discord refused run.completed ev_aaaaaaaaaaaa_1 (404: Unknown Webhook): it is not posted'))
    expect(discordLog(r)).not.toContain('failed (try')
  }, 90_000)

  // 3c final review M11: a payload Discord refuses is refused again on every try, and would hold the rest for an hour
  it('leaves a notification Discord refuses as malformed, says why, and posts the next one', async () => {
    const hook = await webhook([{ status: 400, body: '{"message":"Invalid Form Body","code":50035}' }])
    const { r, ring } = runtime()
    await discord(r, settingsOf(hook.url), [hook.url])
    ring.append([{ type: 'run.completed', jobId: 'job_1', runId: 'run_1', payload: RUN }], now())
    ring.append([{ type: 'run.failed', jobId: 'job_1', runId: 'run_1', payload: { ...RUN, outcome: 'failed' } }], now())
    await until(() => expect(hook.bodies).toHaveLength(1))
    expect(hook.bodies[0]).toMatchObject({ embeds: [{ footer: { text: 'run.failed' } }] })
    await until(() => expect(discordLog(r)).toContain('[warn] Discord refused run.completed ev_aaaaaaaaaaaa_1 (400: Invalid Form Body): it is not posted'))
    expect(discordLog(r)).not.toContain('failed (try')
  }, 90_000)

  it('says how to start it again when its webhook URL is not one', async () => {
    const { r } = runtime({ failAfter: 1 })
    r.start(discordLaunch(settingsOf('discord.com/api/webhooks/1'), ['discord.com/api/webhooks/1']))
    await until(() => expect(r.status(DISCORD_ID)?.status).toBe('failed'))
    await until(() => expect(discordLog(r)).toContain('[host] failed: '))
    expect(discordLog(r)).toMatch(/astera plugins configure.*astera plugins enable/)
  }, 90_000)
})

// Plugin Phase 4 J23: the Linear sample, a job source, against a fake Linear GraphQL endpoint
describe('the Linear source sample', () => {
  const LINEAR = path.join(here, 'linear-source')
  const LINEAR_ID = 'astera-linear-source'
  const KEY = 'lin_api_SECRET0123456789'
  let linearInstalled: string
  beforeAll(async () => {
    linearInstalled = path.join(work, 'installed', LINEAR_ID)
    await copyPluginFolder(LINEAR, linearInstalled)
  }, 60_000)

  const ISSUE = {
    identifier: 'ENG-1',
    title: 'Fix login',
    url: 'https://linear.app/acme/issue/ENG-1/fix-login',
    description: `It fails on Safari.\n${'x'.repeat(300)}`,
    priorityLabel: 'High',
    state: { name: 'Todo' },
    team: { key: 'ENG', name: 'Engineering' },
    assignee: { name: 'Ann' },
    labels: { nodes: [{ name: 'bug' }, { name: 'web' }] }
  }
  type Asked = { authorization: string | undefined; query: string; variables: Record<string, unknown> }
  type Answer = { status?: number; json?: unknown; text?: string }
  const page = (nodes: unknown[], next?: string): Answer => ({
    json: { data: { issues: { nodes, pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null } } } }
  })

  /** A fake Linear GraphQL endpoint: each request's authorization header and body kept, answered by `answer`. */
  async function linear(answer: (asked: Asked) => Answer) {
    const seen: Asked[] = []
    const server = http.createServer((req, res) => {
      let text = ''
      req.setEncoding('utf8').on('data', (c: string) => (text += c))
      req.on('end', () => {
        const body = JSON.parse(text) as { query: string; variables: Record<string, unknown> }
        const asked = { authorization: req.headers.authorization, query: body.query, variables: body.variables }
        seen.push(asked)
        const a = answer(asked)
        res.writeHead(a.status ?? 200, { 'content-type': 'application/json' })
        res.end(a.text ?? JSON.stringify(a.json))
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, seen }
  }

  /** The sample started as Astera starts a job source, and running. */
  async function started(apiUrl: string, extra: Record<string, string> = {}): Promise<PluginRuntime> {
    const { r } = runtime()
    r.start({
      id: LINEAR_ID,
      version: '0.1.0',
      folder: LINEAR_ID,
      dir: linearInstalled,
      entry: path.join(linearInstalled, 'index.mjs'),
      granted: [],
      capabilities: ['job-source'],
      settings: { apiKey: KEY, apiUrl, teamKey: 'ENG', states: 'unstarted, started', ...extra },
      redact: [KEY]
    })
    await until(() => expect(r.status(LINEAR_ID)?.status).toBe('running'))
    return r
  }
  const ask = (r: PluginRuntime, method: string, params: unknown) => r.request(LINEAR_ID, method, params, 15_000)
  /** The failure a request rejected with, as its status and message. */
  const failure = async (p: Promise<unknown>): Promise<{ status: number; message: string }> => {
    try {
      await p
    } catch (e) {
      if (e instanceof PluginRequestFailed) return { status: e.status, message: e.message }
      throw e
    }
    throw new Error('it did not reject')
  }
  const linearLog = (r: PluginRuntime): string => (existsSync(r.logFile(LINEAR_ID)) ? readFileSync(r.logFile(LINEAR_ID), 'utf8') : '')

  it('is a manifest Astera installs: a job source, no permission, a secret key and three settings with defaults', () => {
    const read = parseManifest(JSON.parse(readFileSync(path.join(LINEAR, 'package.json'), 'utf8')))
    if (!read.ok) throw new Error(read.problems.join('; '))
    expect(read.manifest).toMatchObject({ id: LINEAR_ID, apiVersion: '1', entry: 'index.mjs', permissions: [], capabilities: ['job-source'] })
    expect(read.manifest.settings).toEqual([
      expect.objectContaining({ key: 'apiKey', type: 'string', secret: true, required: true }),
      expect.objectContaining({ key: 'teamKey', type: 'string', required: false }),
      expect.objectContaining({ key: 'states', type: 'string', default: 'unstarted,started', required: false }),
      expect.objectContaining({ key: 'apiUrl', type: 'string', default: 'https://api.linear.app/graphql', required: false })
    ])
  })

  it('imports only Node’s own modules, so its folder installs as it is', () => {
    const code = readFileSync(path.join(LINEAR, 'index.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([])
  })

  it('lists a page of issues with the key, the team, the states and the search, and gives the next cursor', async () => {
    const api = await linear((a) => (a.variables.after === null ? page([ISSUE], 'cur-1') : page([{ ...ISSUE, identifier: 'ENG-2', description: '' }])))
    const r = await started(api.url)
    expect(await ask(r, 'jobSource.list', { query: 'login' })).toEqual({
      items: [{ id: 'ENG-1', title: 'Fix login', status: 'Todo', url: ISSUE.url, summary: ISSUE.description.slice(0, 200) }],
      nextCursor: 'cur-1'
    })
    expect(api.seen[0].authorization).toBe(KEY)
    expect(api.seen[0].variables).toEqual({
      first: 30,
      after: null,
      filter: { team: { key: { eqIgnoreCase: 'ENG' } }, state: { type: { in: ['unstarted', 'started'] } }, title: { containsIgnoreCase: 'login' } }
    })
    // The next page from the cursor; the last page gives none, and an issue with no description no summary
    expect(await ask(r, 'jobSource.list', { cursor: 'cur-1' })).toEqual({ items: [{ id: 'ENG-2', title: 'Fix login', status: 'Todo', url: ISSUE.url }] })
    expect(api.seen[1].variables).toMatchObject({ after: 'cur-1', filter: { team: { key: { eqIgnoreCase: 'ENG' } } } })
    expect(api.seen[1].variables.filter).not.toHaveProperty('title')
  }, 90_000)

  // Review Focus 5: an empty teamKey is every team, and no states is every state
  it('asks for every team when teamKey is empty, and every state when states is', async () => {
    const api = await linear(() => page([]))
    const r = await started(api.url, { teamKey: '', states: ' ' })
    expect(await ask(r, 'jobSource.list', {})).toEqual({ items: [] })
    expect(api.seen[0].variables).toEqual({ first: 30, after: null, filter: {} })
  }, 90_000)

  // The 4b review's M6: a team key and state types as a person types them, in any case
  it('matches the team key in any case, and the state types in lower case', async () => {
    const api = await linear(() => page([]))
    const r = await started(api.url, { teamKey: 'eng', states: 'Unstarted, STARTED' })
    await ask(r, 'jobSource.list', {})
    expect(api.seen[0].variables.filter).toEqual({ team: { key: { eqIgnoreCase: 'eng' } }, state: { type: { in: ['unstarted', 'started'] } } })
  }, 90_000)

  // The 4b review's M5: an answer that breaks off, and one with no issues in it, say so in a sentence
  it('says Linear broke off, or answered with no issues, rather than a JavaScript error', async () => {
    let cut = true
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (cut) {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
          res.write('{"data":')
          setTimeout(() => res.destroy(), 20)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { issues: null } }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const r = await started(`http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`)
    expect((await failure(ask(r, 'jobSource.list', {}))).message).toMatch(/^listItems threw: Linear could not be reached: /)
    cut = false
    expect(await failure(ask(r, 'jobSource.list', {}))).toEqual({ status: 502, message: 'listItems threw: Linear answered with no issues' })
  }, 90_000)

  it('reads an issue whole, and makes a Job’s context of it', async () => {
    const api = await linear(() => ({ json: { data: { issue: ISSUE } } }))
    const r = await started(api.url)
    expect(await ask(r, 'jobSource.get', { id: 'ENG-1' })).toEqual({
      id: 'ENG-1',
      title: 'Fix login',
      status: 'Todo',
      url: ISSUE.url,
      body: ISSUE.description,
      fields: { team: 'Engineering', state: 'Todo', priority: 'High', assignee: 'Ann', labels: 'bug, web' }
    })
    expect(api.seen[0].variables).toEqual({ id: 'ENG-1' })
    expect(await ask(r, 'jobSource.context', { id: 'ENG-1' })).toEqual({
      objective: 'Fix login',
      sourceLabel: 'Linear ENG-1',
      sourceUrl: ISSUE.url,
      evidence: [{ label: 'Description', content: ISSUE.description }]
    })
  }, 90_000)

  // Review Focus 4: Linear's own sentence reaches the person, and the key never does
  it('throws Linear’s sentence for an error, a refusal and an unknown issue, and keeps the key out of all of it', async () => {
    let next: Answer = { json: { errors: [{ message: 'Authentication required, not authenticated' }] } }
    const api = await linear(() => next)
    const r = await started(api.url)
    expect(await failure(ask(r, 'jobSource.list', {}))).toEqual({ status: 502, message: 'listItems threw: Linear: Authentication required, not authenticated' })
    next = { status: 401, text: 'Unauthorized' }
    expect(await failure(ask(r, 'jobSource.list', {}))).toEqual({ status: 502, message: 'listItems threw: Linear answered 401' })
    next = { status: 400, json: { errors: [{ message: 'Argument Validation Error' }] } }
    expect(await failure(ask(r, 'jobSource.get', { id: 'ENG-1' }))).toEqual({ status: 502, message: 'getItem threw: Linear answered 400: Argument Validation Error' })
    next = { json: { data: { issue: null } } }
    expect(await failure(ask(r, 'jobSource.context', { id: 'ENG-404' }))).toEqual({ status: 502, message: 'buildJobContext threw: Linear has no issue ENG-404' })
    await until(() => expect(linearLog(r)).toContain('jobSource.context failed'))
    expect(linearLog(r)).not.toContain(KEY)
  }, 90_000)

  it('says where to read about it, and the guide links back', () => {
    expect(readFileSync(path.join(LINEAR, 'README.md'), 'utf8')).toContain('docs/plugins.md#job-source-plugins)')
  })
})

// Plugin Phase 5 C15: the debug-leftovers check, asked as the Host asks it (hostCompletionChecks over the real runtime),
// against real git repositories. Each repository's folder name holds a space.
describe('the debug leftovers sample', () => {
  const LEFTOVERS = path.join(here, 'debug-leftovers')
  const LEFTOVERS_ID = 'astera-debug-leftovers'
  let leftoversInstalled: string
  beforeAll(async () => {
    leftoversInstalled = path.join(work, 'installed', LEFTOVERS_ID)
    await copyPluginFolder(LEFTOVERS, leftoversInstalled)
  }, 60_000)
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeFixture(d)
  })

  /** The sample started as Astera starts a completion check, running, and asked the way the Host asks it. */
  async function checker(patterns = 'console.log,debugger,TODO,FIXME', env?: NodeJS.ProcessEnv) {
    const { r } = runtime({ env })
    r.start({
      id: LEFTOVERS_ID,
      version: '0.1.0',
      folder: LEFTOVERS_ID,
      dir: leftoversInstalled,
      entry: path.join(leftoversInstalled, 'index.mjs'),
      granted: [],
      capabilities: ['completion-check'],
      settings: { patterns },
      redact: []
    })
    await until(() => expect(r.status(LEFTOVERS_ID)?.status).toBe('running'))
    const manager = {
      listNow: async () => ({
        status: 200,
        body: { plugins: [{ id: LEFTOVERS_ID, displayName: 'Debug leftovers', enabled: true, status: 'running', capabilities: ['completion-check'] }] }
      })
    }
    const checks = hostCompletionChecks({ manager: manager as never, runtime: r })
    return (root: string, base?: string) =>
      checks.run(LEFTOVERS_ID, { jobId: 'job_1', runId: 'run_1', taskId: 't1', task: { title: 'Fix login' }, workspace: { root, ...(base !== undefined ? { base } : {}) } })
  }
  const check0 = async (root: string, base?: string) => (await checker())(root, base)

  const write = async (dir: string, files: Record<string, string | Buffer>): Promise<void> => {
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await fs.writeFile(path.join(dir, name), text)
    }
  }
  /** A repository with `files` committed: its folder and that commit. */
  async function repo(files: Record<string, string>): Promise<{ dir: string; base: string }> {
    const dir = await tempDir('astera-leftovers repo ')
    dirs.push(dir)
    gitSync(dir, ['init', '-b', 'main'])
    gitSync(dir, ['config', 'user.email', 't@t.com'])
    gitSync(dir, ['config', 'user.name', 'Test User'])
    await write(dir, files)
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-m', 'base'])
    return { dir, base: gitSync(dir, ['rev-parse', 'HEAD']) }
  }
  const commit = (dir: string): void => {
    gitSync(dir, ['add', '-A'])
    gitSync(dir, ['commit', '-m', 'work'])
  }
  const found = (file: string, line: number, pattern: string) => ({ file, line, message: `adds ${pattern}`, severity: 'error' })

  it('is a manifest Astera installs: a completion check, no permission, and a patterns setting with the defaults', () => {
    const read = parseManifest(JSON.parse(readFileSync(path.join(LEFTOVERS, 'package.json'), 'utf8')))
    if (!read.ok) throw new Error(read.problems.join('; '))
    expect(read.manifest).toMatchObject({ id: LEFTOVERS_ID, displayName: 'Debug leftovers', apiVersion: '1', entry: 'index.mjs', permissions: [], capabilities: ['completion-check'] })
    expect(read.manifest.settings).toEqual([expect.objectContaining({ key: 'patterns', type: 'string', default: 'console.log,debugger,TODO,FIXME', required: false })])
  })

  it('imports only Node’s own modules, so its folder installs as it is', () => {
    const code = readFileSync(path.join(LEFTOVERS, 'index.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(specifiers).toContain('node:child_process')
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([])
  })

  // The design's "what success looks like": the worker is told the file and the line, and the recheck passes
  it('fails a Task that adds leftovers in what it committed, what it left uncommitted and a new file, and passes once they are gone', async () => {
    const { dir, base } = await repo({ 'src/app.js': 'const a = 1\n', 'src/util.js': 'export const u = 1\nexport const v = 2\n' })
    await write(dir, { 'src/app.js': 'const a = 1\nconsole.log(a)\n' })
    commit(dir)
    await write(dir, { 'src/util.js': 'export const u = 1\nexport const v = 2\ndebugger\n', 'src/new file.js': 'export const x = 1\r\n// FIXME later\r\n' })
    const check = await checker()
    const failed = await check(dir, base)
    expect(failed).toEqual({
      name: 'Debug leftovers',
      status: 'failed',
      summary: '3 debug leftovers in 3 files',
      // In git's order: one diff reads the new file beside the tracked ones
      diagnostics: [found('src/app.js', 2, 'console.log'), found('src/new file.js', 2, 'FIXME'), found('src/util.js', 3, 'debugger')]
    })
    expect(pluginCheckText({ configId: `plugin:${LEFTOVERS_ID}`, ...failed })).toContain('src/app.js:2 adds console.log')
    await write(dir, { 'src/app.js': 'const a = 1\n', 'src/util.js': 'export const u = 1\nexport const v = 2\n', 'src/new file.js': 'export const x = 1\r\n' })
    expect(await check(dir, base)).toEqual({ name: 'Debug leftovers', status: 'passed', summary: 'no debug leftovers in 1 changed file' })
  }, 90_000)

  it('looks only at the lines a Task adds: a leftover its base had, or one it removes, is not its', async () => {
    const { dir, base } = await repo({ 'src/app.js': 'console.log(1)\nconst a = 1\n// TODO keep\n' })
    await write(dir, { 'src/app.js': 'const a = 2\n// TODO keep\n' })
    expect(await check0(dir, base)).toEqual({ name: 'Debug leftovers', status: 'passed', summary: 'no debug leftovers in 1 changed file' })
  }, 90_000)

  it('with no base, looks at what is not committed yet', async () => {
    const { dir } = await repo({ 'src/app.js': 'const a = 1\n' })
    await write(dir, { 'src/app.js': 'const a = 1\nconsole.log(a)\n' })
    commit(dir)
    await write(dir, { 'src/b.js': 'debugger\n' })
    expect((await check0(dir)).diagnostics).toEqual([found('src/b.js', 1, 'debugger')])
  }, 90_000)

  it('looks for the patterns its setting names, as written, and for the defaults when it names none', async () => {
    const { dir, base } = await repo({ 'a.py': 'x = 1\n' })
    await write(dir, { 'a.py': 'x = 1\nprint(x)\nconsole.log(x)\nPrint(x)\n' })
    expect((await (await checker('print(, pdb.set_trace'))(dir, base)).diagnostics).toEqual([found('a.py', 2, 'print(')])
    expect((await (await checker(' , '))(dir, base)).diagnostics).toEqual([found('a.py', 3, 'console.log')])
  }, 120_000)

  // Review Focus 2
  it('reads a new file whole unless git ignores it, it is binary, or it is larger than 1 MB', async () => {
    const { dir, base } = await repo({ '.gitignore': 'dist/\n' })
    await write(dir, {
      'dist/bundle.js': 'console.log(1)\n',
      'blob.bin': Buffer.from('console.log\0', 'utf8'),
      'big.js': `${'x\n'.repeat(600_000)}console.log(1)\n`,
      'small.js': 'console.log(1)\n'
    })
    expect(await check0(dir, base)).toMatchObject({ status: 'failed', summary: '1 debug leftover in 1 file', diagnostics: [found('small.js', 1, 'console.log')] })
  }, 90_000)

  // 5e (performance review): a worktree of thousands of files git does not ignore is not read one by one for a minute:
  // the check cannot be made, and says what to do
  it('answers error for more than 2,000 new files git does not ignore, and reads 2,000', async () => {
    const { dir, base } = await repo({ 'a.js': '' })
    const many: Record<string, string> = {}
    for (let i = 0; i < 2_001; i++) many[`gen/f${i}.txt`] = 'x\n'
    await write(dir, many)
    const over = await check0(dir, base)
    expect(over.status).toBe('error')
    expect(over.summary).toBe('2,001 new files are not ignored by git, more than 2,000 to read: add the folder they are generated in to .gitignore')
    await fs.rm(path.join(dir, 'gen', 'f2000.txt'))
    await write(dir, { 'gen/f0.txt': 'console.log(1)\n' })
    const read = await check0(dir, base)
    expect(read.status).toBe('failed')
    expect(read.diagnostics).toEqual([found('gen/f0.txt', 1, 'console.log')])
  }, 180_000)

  // 5e (performance review): git's output is split in one pass, so a line of tens of megabytes costs its size
  it('splits a stream into items across chunks, a long item over many, and the last one at its end', () => {
    const items: string[] = []
    const lines = itemSplitter('\n', (i) => items.push(i))
    lines.push('a\nb')
    lines.push('c\n')
    for (let i = 0; i < 1_000; i++) lines.push('x'.repeat(64))
    lines.push('\nlast')
    lines.end()
    expect(items).toEqual(['a', 'bc', 'x'.repeat(64_000), 'last'])
    const names: string[] = []
    const nul = itemSplitter('\0', (i) => names.push(i))
    nul.push('one\0tw')
    nul.push('o\0')
    nul.end()
    expect(names).toEqual(['one', 'two'])
  })

  // 5d: Astera keeps 20 findings; the sample sends those and says how many there are
  it('names the first 20 findings and counts them all', async () => {
    const { dir, base } = await repo({ 'a.js': '' })
    await write(dir, { 'a.js': 'console.log(1)\n'.repeat(150) })
    const answer = await check0(dir, base)
    expect(answer.summary).toBe('150 debug leftovers in 1 file')
    expect(answer.diagnostics).toHaveLength(20)
    expect(answer.diagnostics?.[19]).toEqual(found('a.js', 20, 'console.log'))
    expect(answer.diagnosticsTotal).toBe(150)
  }, 90_000)

  // Review Focus 1: git puts a tab after a name with a space, and prints a name outside ASCII as it is (core.quotepath off)
  it('names a file whose path holds a space or a letter outside ASCII as it is on disk', async () => {
    const { dir, base } = await repo({ 'src/naïve café.js': 'const a = 1\n' })
    await write(dir, { 'src/naïve café.js': 'const a = 1\nconsole.log(a)\n', 'src/über neu.js': 'debugger\n' })
    expect((await check0(dir, base)).diagnostics).toEqual([found('src/naïve café.js', 2, 'console.log'), found('src/über neu.js', 1, 'debugger')])
  }, 90_000)

  // Review Focus 1: a name with a quote or a backslash, which git prints quoted; Windows allows neither in a name
  it.skipIf(process.platform === 'win32')('names a file whose path holds a quote and a backslash, which git prints quoted', async () => {
    const { dir, base } = await repo({ 'we"ird\\name.js': 'const a = 1\n' })
    await write(dir, { 'we"ird\\name.js': 'const a = 1\nconsole.log(a)\n', 'new"one.js': 'debugger\n' })
    // In git's path order, as every finding is since one diff reads the new files too (5b final review I1)
    expect((await check0(dir, base)).diagnostics).toEqual([found('new"one.js', 1, 'debugger'), found('we"ird\\name.js', 2, 'console.log')])
  }, 90_000)

  // Review Focus 3
  it('looks only at the Task folder’s own changes when it is a subfolder of the repository, naming files from it', async () => {
    const { dir, base } = await repo({ 'pkg/a.js': 'const a = 1\n', 'other/b.js': 'const b = 1\n' })
    await write(dir, { 'pkg/a.js': 'const a = 1\nconsole.log(a)\n', 'other/b.js': 'const b = 1\nconsole.log(b)\n', 'other/new.js': 'debugger\n', 'pkg/new.js': '// TODO\n' })
    expect((await check0(path.join(dir, 'pkg'), base)).diagnostics).toEqual([found('a.js', 2, 'console.log'), found('new.js', 1, 'TODO')])
  }, 90_000)

  // Review Focus 4, and 5b final review I1 and I2: context between nearby hunks, renames turned off, a submodule's diff
  it('finds the same whatever the repository’s git config says of colours, prefixes, quoting, context, renames and diff tools', async () => {
    const { dir, base } = await repo({ 'a b.js': 'l1\nl2\n\nl4\nl5\n', 'old.js': 'a\nb\n// TODO keep\n' })
    const config = [
      ['color.ui', 'always'],
      ['color.diff', 'always'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.external', 'no-such-diff-tool'],
      ['diff.relative', 'false'],
      ['diff.interHunkContext', '5'],
      ['diff.suppressBlankEmpty', 'true'],
      ['diff.renames', 'false'],
      ['diff.submodule', 'diff'],
      ['core.quotepath', 'true']
    ]
    for (const [k, v] of config) gitSync(dir, ['config', k, v])
    await write(dir, { 'a b.js': 'l1\nconsole.log(1)\nl2\n\nl4\nl5\ndebugger\n', 'é.js': 'debugger\n' })
    gitSync(dir, ['mv', 'old.js', 'moved.js'])
    expect((await check0(dir, base)).diagnostics).toEqual([found('a b.js', 2, 'console.log'), found('a b.js', 7, 'debugger'), found('é.js', 1, 'debugger')])
  }, 90_000)

  // 5b final review I1: git documents GIT_DIFF_OPTS as overriding --unified, so context lines can come in any repository
  it('counts lines right when GIT_DIFF_OPTS asks git for context', async () => {
    const { dir, base } = await repo({ 'a.js': 'l1\nl2\n\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n' })
    await write(dir, { 'a.js': 'l1\nconsole.log(1)\nl2\n\nl4\nl5\nl6\nl7\nl8\nl9\nl10\ndebugger\n' })
    const check = await checker(undefined, { ...process.env, GIT_DIFF_OPTS: '--unified=3' })
    expect((await check(dir, base)).diagnostics).toEqual([found('a.js', 2, 'console.log'), found('a.js', 12, 'debugger')])
  }, 90_000)

  // 5b final review I2: a submodule's own changes are its repository's, not the Task's
  it('reads no submodule’s own changes, whatever diff.submodule says', async () => {
    const sub = await repo({ 's.js': 'const s = 1\n' })
    const { dir } = await repo({ 'a.js': 'const a = 1\n' })
    gitSync(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub.dir, 'vendored'])
    gitSync(dir, ['commit', '-m', 'add the submodule'])
    const base = gitSync(dir, ['rev-parse', 'HEAD'])
    gitSync(dir, ['config', 'diff.submodule', 'diff'])
    const vendored = path.join(dir, 'vendored')
    gitSync(vendored, ['config', 'user.email', 't@t.com'])
    gitSync(vendored, ['config', 'user.name', 'Test User'])
    await write(vendored, { 's.js': 'const s = 1\nconsole.log(s)\n' })
    commit(vendored)
    expect(await check0(dir, base)).toMatchObject({ status: 'passed' })
  }, 90_000)

  // 5b final review M1: a lone carriage return is not a line break to git, nor to a file read whole
  it('takes a lone carriage return in a line as part of the line', async () => {
    const { dir, base } = await repo({ 'a.js': 'x\n' })
    await write(dir, { 'a.js': 'x\nprogress 10%\rconsole.log(1)\n+fake\r+debugger\nlast TODO\n' })
    expect((await check0(dir, base)).diagnostics).toEqual([found('a.js', 2, 'console.log'), found('a.js', 3, 'debugger'), found('a.js', 4, 'TODO')])
  }, 90_000)

  // 5b final review M2: a move without `git add` is a move, and what the file held before is not the Task's
  it('reads a file moved without git add as a move', async () => {
    const { dir, base } = await repo({ 'src/old.js': 'a\nb\n// TODO keep\n' })
    await fs.rename(path.join(dir, 'src/old.js'), path.join(dir, 'src/new.js'))
    expect(await check0(dir, base)).toEqual({ name: 'Debug leftovers', status: 'passed', summary: 'no debug leftovers in 1 changed file' })
    // The person's own index is left as it was: the new file is still not added
    expect(gitSync(dir, ['status', '--porcelain'])).toContain('?? src/new.js')
  }, 90_000)

  // 5b final review M3: git sees a link's text, not the file it points at; Windows makes links only with a privilege
  it.skipIf(process.platform === 'win32')('reads a new symbolic link as git does, not the file it points at', async () => {
    const { dir, base } = await repo({ 'a.js': '' })
    const outside = await tempDir('astera-leftovers outside ')
    dirs.push(outside)
    await write(outside, { 'loud.js': 'console.log(1)\n' })
    await fs.symlink(path.join(outside, 'loud.js'), path.join(dir, 'link.js'))
    expect(await check0(dir, base)).toMatchObject({ status: 'passed' })
  }, 90_000)

  // 5b final review M4: a repository with no commit yet, and no base, reads everything in it as the Task's
  it('reads a repository with no commit yet whole', async () => {
    const dir = await tempDir('astera-leftovers fresh ')
    dirs.push(dir)
    gitSync(dir, ['init', '-b', 'main'])
    await write(dir, { 'staged.js': 'debugger\n', 'loose.js': 'x\nconsole.log(1)\n' })
    gitSync(dir, ['add', 'staged.js'])
    expect((await check0(dir)).diagnostics).toEqual([found('loose.js', 2, 'console.log'), found('staged.js', 1, 'debugger')])
  }, 90_000)

  // 5b final review M14: the sentence a person reads when git is not there
  it('says git could not be started when it is not on the PATH', async () => {
    const { dir, base } = await repo({ 'a.js': '' })
    // An empty folder as the PATH: without one, Windows hands a child its parent's PATH and POSIX looks in /usr/bin
    const empty = await tempDir('astera-leftovers no git ')
    dirs.push(empty)
    const noGit = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: empty }
    const check = await checker(undefined, noGit)
    expect(await check(dir, base)).toMatchObject({ status: 'error', summary: expect.stringMatching(/^git could not be started: is it installed/) })
  }, 90_000)

  it('answers error with git’s sentence for a folder that is not a repository or a base that is not a commit, and says so for a folder that is gone', async () => {
    const plain = await tempDir('astera-leftovers plain ')
    dirs.push(plain)
    // git's sentence in English: a Mac in Korean answered "깃 저장소가 아닙니다" (the Mac check, 2026-11-02)
    const check = await checker(undefined, { ...process.env, LC_ALL: 'C' })
    expect(await check(plain)).toMatchObject({ status: 'error', summary: expect.stringMatching(/^git [a-z-]+: .*not a git repository/i) })
    const { dir } = await repo({ 'a.js': '' })
    expect(await check(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toMatchObject({
      status: 'error',
      summary: expect.stringMatching(/^git diff: .*(bad object|bad revision|unknown revision)/i)
    })
    const gone = path.join(plain, 'gone')
    expect(await check(gone)).toMatchObject({ status: 'error', summary: `the Task’s folder is not there: ${gone}` })
  }, 90_000)

  it('says where to read about it, and the guide links back', () => {
    const readme = readFileSync(path.join(LEFTOVERS, 'README.md'), 'utf8')
    expect(readme).toContain('docs/plugins.md#completion-check-plugins)')
    // 5b final review M13: git's sentence when git fails; the sample's own when git is missing or the folder is gone
    expect(readme).not.toContain("The summary is git's own sentence")
    expect(readme.replace(/\s+/g, ' ')).toContain('git 2.25 or later')
  })
})
