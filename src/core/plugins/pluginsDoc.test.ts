// docs/plugins.md, the plugin author's guide (plugins 2f), is checked against the code it describes: the permissions
// and the SDK methods each opens, the runtime's waits and counts, the redaction floor, the secret and settings limits,
// the capabilities this Astera does not run yet, and the Node a plugin runs on. Its quick start is run as written in
// the real plugin runtime, its TypeScript compiles against the SDKs, its links land, and it is published.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { removeFixture } from '../testFixtures'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_CAPABILITIES, PLUGIN_PERMISSIONS, PLUGIN_TRUST_WARNING, capabilityPermissionProblem, parseManifest } from './manifest'
import { SETTING_KEYWORDS, SETTING_TYPES, SETTINGS_MAX, parseSettingsSchema } from './settings'
import { PLUGIN_COMMAND_PERMISSIONS, SDK_COMMANDS_CLOSED_TO_PLUGINS, pluginRefusal } from '../host/pluginGate'
import { LOG_CHARS_PER_SECOND, LOG_LINES_PER_SECOND, PLUGIN_TIMINGS, REDACT_MIN, createPluginRuntime } from '../../host/plugins/runtime'
import { SECRET_NAME_MAX, SECRET_VALUE_MAX } from '../../host/plugins/pluginData'
import { PLUGIN_SERVED_CAPABILITIES } from '../../host/plugins/manager'
import { DELIVERY_GIVE_UP_MS, DELIVERY_LOG_EVERY, DELIVERY_RETRY_MS, DELIVERY_TIMEOUT_MS } from '../../host/plugins/deliverer'
import { EVENT_RETAIN_EVENTS } from '../../host/eventLog'
import { NOTIFICATION_KINDS, NOTIFICATION_LEVEL, NOTIFICATION_MAX_AGE_MS, NOTIFICATION_TITLE_MAX, NOTIFICATION_VALUE_MAX } from './notifications'
import { t, type MessageKey } from '../i18n'
import { JOB_SOURCE_TIMEOUT_MS } from '../../host/jobSources'
import {
  SOURCE_BODY_MAX,
  SOURCE_CURSOR_MAX,
  SOURCE_EVIDENCE_MAX,
  SOURCE_EVIDENCE_TOTAL_MAX,
  SOURCE_FIELDS_MAX,
  SOURCE_ID_MAX,
  SOURCE_ITEMS_MAX,
  SOURCE_LABEL_MAX,
  SOURCE_OBJECTIVE_MAX,
  SOURCE_SUMMARY_MAX,
  SOURCE_TITLE_MAX,
  SOURCE_URL_MAX
} from '../sources/answers'
import { CHECK_DIAGNOSTICS_MAX, CHECK_FILE_MAX, CHECK_MESSAGE_MAX, CHECK_SUMMARY_MAX, REPAIR_DIAGNOSTICS } from '../orchestration/pluginChecks'
import { CHECK_TIMEOUT_MS } from '../orchestration/types'
import { CHECK_UNAVAILABLE_OPTIONS } from '../orchestration/state'
import { HUMAN_DIAGNOSTICS } from '../orchestration/cliHuman'
import { bundleLauncher } from '../../pluginHost/testkit'
import { transform } from 'esbuild'
import { PluginRequestFailed } from '../../host/plugins/runtime'
import { gitSync, tempDir } from '../worktrees/testRepo'
import { createNamespaces } from '../../../packages/client/src/namespaces'
import { typecheckBlocks } from '../../../packages/client/test/typecheck'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (f: string): string => readFileSync(path.join(root, f), 'utf8')
const guide = read('docs/plugins.md')

/** One section, from its heading to the next heading of the same or a higher level. */
const section = (doc: string, heading: string): string => {
  const at = doc.indexOf(`\n${heading}\n`)
  if (at < 0) return ''
  const level = heading.match(/^#+/)![0].length
  const rest = doc.slice(at + heading.length + 2)
  const end = rest.search(new RegExp(`\\n#{1,${level}} `))
  return end < 0 ? rest : rest.slice(0, end)
}
const fenced = (doc: string, lang: string): string[] => [...doc.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, 'gm'))].map((m) => m[1])
/** The text outside its fenced blocks, with its lines joined: what a reader takes as a statement. */
const prose = (doc: string): string => doc.replace(/^```[\s\S]*?^```$/gm, '').replace(/\s+/g, ' ')
/** GitHub's heading anchor, for the headings this guide uses. */
const slug = (h: string): string => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-')
const anchors = (doc: string): Set<string> => new Set([...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])))

/** The SDK's typed methods, `namespace.method`. */
const methods = Object.entries(createNamespaces(() => Promise.reject(new Error('no Host')), () => [])).flatMap(([name, api]) =>
  Object.keys(api as object).map((m) => `${name}.${m}`)
)
/** The Host command an SDK method sends: `jobs.list` sends `jobs-list`, with the few the client names otherwise. */
const commandOf = (method: string): string =>
  method.startsWith('events.')
    ? 'events-poll'
    : method === 'tasks.create'
      ? 'tasks-add'
      : method === 'completion.get'
        ? 'runs-completion'
        : method.startsWith('agentProfiles.')
          ? `agent-profiles-${method.slice('agentProfiles.'.length)}`
          : method.replace('.', '-')

describe('docs/plugins.md', () => {
  it('says plainly that a plugin is trusted code and its permissions are not a sandbox', () => {
    expect(guide).toContain(`**${PLUGIN_TRUST_WARNING}**`)
    const trust = prose(section(guide, '## Plugins are trusted code'))
    expect(trust).toMatch(/not a sandbox/)
    // 2f final review m2: `--yes` approves without showing it
    expect(trust).toContain('without `--yes`')
  })

  it('gives each permission the SDK methods the Host opens with it, and nothing else', () => {
    const table = section(guide, '## Permissions')
    const rows = new Map([...table.matchAll(/^\| `([a-z.-]+)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]))
    expect([...rows.keys()].sort()).toEqual([...PLUGIN_PERMISSIONS].sort())
    for (const [permission, cell] of rows) {
      const named = [...cell.matchAll(/`([a-z]+\.[A-Za-z]+)`/g)].map((m) => m[1])
      for (const m of named) expect(methods, m).toContain(m)
      const opens = Object.entries(PLUGIN_COMMAND_PERMISSIONS)
        .filter(([, p]) => p === permission)
        .map(([c]) => c)
        .sort()
      expect([...new Set(named.map(commandOf))].sort(), permission).toEqual(opens)
      if (opens.length === 0) expect(cell, permission).toBe('nothing yet')
    }
    // And every SDK method a plugin can call is in the table, in its permission's row; the ones no permission opens are
    // named as closed beside it
    for (const m of methods) {
      if (SDK_COMMANDS_CLOSED_TO_PLUGINS.has(commandOf(m))) {
        expect(prose(table), m).toContain(`\`${m}\``)
        continue
      }
      const needs = PLUGIN_COMMAND_PERMISSIONS[commandOf(m)]
      expect(needs, m).toBeDefined()
      expect(rows.get(needs!), m).toContain(`\`${m}\``)
    }
    expect(prose(table)).toContain("call('requests-show'")
    expect(prose(table)).toContain('`PERMISSION_DENIED`')
  })

  it('gives the waits and counts the runtime uses', () => {
    const t = PLUGIN_TIMINGS
    const nth = ['first', 'second', 'third', 'fourth', 'fifth'][t.failAfter - 1]
    const life = prose(section(guide, '## Lifecycle'))
    expect(life).toContain(`within ${t.startMs / 1000} seconds`)
    expect(life).toContain(`${t.stopGraceMs / 1000} seconds to finish`)
    expect(life).toContain(`started again after ${t.backoffMs[0] / 1000}, then ${t.backoffMs[1] / 1000} seconds`)
    expect(life).toContain(`the ${nth} crash without ${t.stableMs / 1000} seconds of steady running`)
    // 2f final review I2: configuring a failed plugin does not start it (manager.ts, and cli.md says so too)
    expect(life).toContain('a `failed` one stays stopped until `astera plugins enable` starts it')
    expect(prose(section(guide, '## Troubleshooting'))).toContain('configuring it alone does not start it again')
    // 2f final review m5: the process ends as soon as deactivate resolves
    expect(life).toContain('inside `deactivate`')
  })

  it('says which values its log hides and which it cannot', () => {
    expect(prose(section(guide, '## Logs'))).toContain(`a value shorter than ${REDACT_MIN} characters is not hidden`)
    // 5e: the budget a second, in the runtime's own numbers, what it covers, and that Astera's own lines are never dropped
    const logs = prose(section(guide, '## Logs'))
    expect(logs).toContain(`${LOG_LINES_PER_SECOND.toLocaleString('en-US')} lines or ${LOG_CHARS_PER_SECOND.toLocaleString('en-US')} characters a second`)
    expect(logs).toContain('its `ctx.log` lines and the launcher’s included')
    expect(logs).toContain('Astera’s own `[host]` lines are never dropped')
  })

  // 2f final review m4: what a refused call leaves in the log is the Host's sentence, not the error code
  it('quotes the refusal a plugin without a permission gets, as the gate words it', () => {
    const words = pluginRefusal('jobs-list', { id: 'ID', granted: new Set() })!.body.error
    const shape = words.replace('jobs-list', '<command>').replace('jobs.read', '<permission>').replace('ID', '<id>')
    expect(shape).toBe('<command> needs the <permission> permission, which plugin <id> was not granted')
    expect(prose(section(guide, '## Troubleshooting'))).toContain(shape)
  })

  it('gives the secret limits the store keeps, as the SDK’s own types do', () => {
    const value = `${SECRET_VALUE_MAX.toLocaleString('en-US')} characters`
    const settings = prose(section(guide, '## Settings and secrets'))
    expect(settings).toContain(`at most ${SECRET_NAME_MAX}`)
    expect(settings).toContain(value)
    // 2f final review m3: the store is files under the profile, which any program running as you can read
    for (const doc of [settings, prose(read('docs/cli.md'))]) expect(doc).toContain('no other plugin can read it through Astera')
    const sdk = read('packages/plugin-sdk/src/index.ts').replace(/\s+\*?\s*/g, ' ')
    expect(sdk).toContain(`at most ${SECRET_NAME_MAX}`)
    expect(sdk).toContain(value)
  })

  it('lists the settings types and keywords the parser takes, and how many settings it takes', () => {
    const settings = section(guide, '## Settings and secrets')
    for (const t of SETTING_TYPES) expect(settings, t).toContain(`\`${t}\``)
    for (const k of SETTING_KEYWORDS) expect(settings, k).toContain(`\`${k}\``)
    expect(prose(settings)).toContain(`at most ${SETTINGS_MAX} settings`)
    // 2f final review m8: the example is one a manifest can hold
    const [example] = fenced(settings, 'json')
    expect(parseSettingsSchema((JSON.parse(`{${example}}`) as { settingsSchema: unknown }).settingsSchema)).toMatchObject({ ok: true })
  })

  // 2f final review m8, m9: what the guide says of the copy and of npm is what copyFolder.ts and npm.ts do
  it('names the copy rules and the npm flags the Host uses', () => {
    const copy = read('src/host/plugins/copyFolder.ts')
    const folder = section(guide, '### From a folder')
    for (const f of ['.pnpm', '.store']) {
      expect(copy, f).toContain(`folder: '${f}'`)
      expect(folder, f).toContain(`node_modules/${f}`)
    }
    expect(copy).toContain("e.name === '.git'")
    expect(folder).toContain('`.git` at the top is left out')
    const npm = section(guide, '### From npm')
    const install = /\['install', ([^\]]+)\]/.exec(read('src/host/plugins/npm.ts'))![1]
    const flags = [...prose(npm).matchAll(/--[a-z-]+(?:=[a-z]+)?/g)].map((m) => m[0])
    expect(flags.length).toBeGreaterThanOrEqual(4)
    for (const f of flags) expect(install, f).toContain(`'${f}'`)
    expect(install).toContain("'--no-package-lock'")
    expect(prose(npm)).toContain('`package-lock.json`')
    expect(read('src/host/plugins/npm.ts')).toContain("own('optionalDependencies')")
    expect(prose(npm)).toContain('`optionalDependencies`')
    // cmd.exe takes ^ for its escape character, so a range is quoted where it is given
    for (const l of fenced(guide, 'sh').join('\n').split('\n').filter((l) => l.includes('^'))) expect(l, l).toMatch(/"[^"\s]*\^[^"\s]*"/)
  })

  it('gives the other limits the parsers and the Host keep', () => {
    // Through the parsers: each limit holds, and one character past it does not
    const field = (f: Record<string, unknown>, key = 'k'): boolean => parseSettingsSchema({ type: 'object', properties: { [key]: { type: 'string', ...f } } }).ok
    const settings = prose(section(guide, '## Settings and secrets'))
    expect([field({ title: 'x'.repeat(64) }), field({ title: 'x'.repeat(65) })]).toEqual([true, false])
    expect(settings).toContain('`title` (up to 64 characters)')
    expect([field({ description: 'x'.repeat(500) }), field({ description: 'x'.repeat(501) })]).toEqual([true, false])
    expect(settings).toContain('`description` (up to 500)')
    const choices = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`)
    expect([field({ enum: choices(50) }), field({ enum: choices(51) })]).toEqual([true, false])
    expect(settings).toContain('`enum` (up to 50 choices')
    expect([field({}, `k${'x'.repeat(63)}`), field({}, `k${'x'.repeat(64)}`)]).toEqual([true, false])
    expect(settings).toContain('letters, digits or `_`, at most 64 characters')
    const manifest = (extra: Record<string, unknown>) => parseManifest({ name: 'p', version: '1.0.0', astera: { apiVersion: '1', entry: 'i.js' }, ...extra })
    expect([manifest({ displayName: 'x'.repeat(64) }).ok, manifest({ displayName: 'x'.repeat(65) }).ok]).toEqual([true, false])
    const long = manifest({ description: 'x'.repeat(600) })
    expect(long.ok && long.manifest.description?.length).toBe(500)
    const fields = section(guide, '## The manifest')
    expect(fields).toContain('| `displayName` | Optional. What the app shows, up to 64 characters. |')
    expect(fields).toContain('its first 500 characters')
    // Read as text: neither is exported
    const constant = (file: string, name: string): number => {
      const m = new RegExp(`^(?:export )?const ${name} = ([\\d_ *]+)$`, 'm').exec(read(file))
      if (!m) throw new Error(`${file} has no ${name}`)
      return m[1].split('*').reduce((n, f) => n * Number(f.trim().replace(/_/g, '')), 1)
    }
    const entries = constant('src/host/plugins/tarball.ts', 'ENTRIES_MAX').toLocaleString('en-US')
    const mib = constant('src/host/plugins/tarball.ts', 'BYTES_MAX') / 1024 / 1024
    expect(prose(section(guide, '### From npm'))).toContain(`more than ${entries} entries or ${mib} MiB`)
    expect(prose(section(guide, '## Logs'))).toContain(`It is kept to ${constant('src/host/log.ts', 'DEFAULT_MAX_BYTES') / 1024 / 1024} MiB`)
  })

  // SDK packages on npm: the plugin SDK is installed by name, and npm brings the client its types import
  it('installs the plugin SDK by name, in the guide and on its npm page', () => {
    const ts = section(guide, '### TypeScript, and bundling')
    expect(ts).toContain('npm install --save-dev @astera-app/plugin-sdk')
    // Final review m2: the example uses process, whose types are Node's, which a new tsconfig leaves out
    expect(ts).toMatch(/npm install --save-dev @astera-app\/plugin-sdk typescript @types\/node\n/)
    expect(ts).toContain('"types": ["node"]')
    expect(guide).not.toMatch(/not on npm yet/)
    expect(section(guide, '## Not yet')).not.toContain('@astera-app/plugin-sdk')
    // Its example imports definePlugin when the plugin runs, so there it is a dependency, which an npm install keeps
    const readme = read('packages/plugin-sdk/README.md')
    expect(readme).toContain('npm install @astera-app/plugin-sdk\n')
    expect(readme).toContain('docs/plugins.md#typescript-and-bundling')
    expect(readme).not.toMatch(/not published/i)
  })

  // Every capability runs since plugin Phase 5: Not yet names a capability exactly when this Astera does not run it
  it('names each kind of plugin this Astera does not run yet, and no kind it runs', () => {
    const notYet = section(guide, '## Not yet')
    for (const c of PLUGIN_CAPABILITIES) expect(notYet.includes(`\`${c}\``), c).toBe(!PLUGIN_SERVED_CAPABILITIES.includes(c))
  })

  // Plugin Phase 3 N4-N9: the event capability as the code runs it
  it('says how an event plugin is handed events, with the deliverer’s numbers and the permission rule', () => {
    const ev = prose(section(guide, '## Event plugins'))
    expect(ev).toContain('`onEvent`')
    expect(ev).toContain(`within ${DELIVERY_TIMEOUT_MS / 1000} seconds`)
    expect(ev).toContain(`after ${DELIVERY_RETRY_MS.first / 1000} second,`)
    expect(ev).toContain(`up to ${DELIVERY_RETRY_MS.max / 60_000} minutes`)
    expect(DELIVERY_GIVE_UP_MS).toBe(60 * 60_000)
    expect(ev).toContain('after an hour')
    expect(ev).toContain(`every ${DELIVERY_LOG_EVERY} tries`)
    expect(ev).toContain("`{ type: 'gap' }`")
    expect(ev).toContain('`events.subscribe`')
    expect(ev).toContain(capabilityPermissionProblem(['event'], [])!)
    expect(ev).toContain('`<profile>/plugins/cursors/<folder>.json`')
    expect(ev).toContain('`event.id`')
    // Its manifest fragment is one Astera reads as an event plugin
    const [fragment] = fenced(section(guide, '## Event plugins'), 'json')
    const read = parseManifest({ name: 'x', version: '1.0.0', astera: { apiVersion: '1', entry: 'index.js', ...JSON.parse(fragment) } })
    expect(read.ok && read.manifest.capabilities).toEqual(['event'])
    expect(section(guide, '## Not yet')).not.toContain('`event`')
    expect(prose(section(guide, '## The manifest'))).toContain('[Event plugins](#event-plugins)')
    // Final review M5, then 5d: a call past the limit is cancelled through its ctx.signal; one that ignores it goes on
    // beside the next try, so one-at-a-time holds only for handlers within it
    expect(ev).toContain(`When a call runs past ${DELIVERY_TIMEOUT_MS / 1000} seconds Astera stops waiting and aborts that call's \`ctx.signal\``)
    expect(ev).toContain('A handler that does not stop goes on beside the event')
    // Final review M6: the place is taken when the plugin first starts, which a plugin missing a setting has not
    expect(ev).toContain('after it first starts')
    expect(ev).not.toContain('after its install')
    // Final review M10: what the log keeps, tied to the code
    expect(ev).toContain(`up to its most recent ${EVENT_RETAIN_EVENTS} events, fewer`)
  })

  // Plugin Phase 3 N9-N12: the notification capability as the Host words it
  it('says how a notification plugin is sent notifications: each kind with its level and its English sentence', () => {
    const sec = section(guide, '## Notification plugins')
    const nt = prose(sec)
    expect(nt).toContain('`send`')
    expect(nt).toContain('`defineNotificationProvider`')
    expect(nt).toContain('the language the app is set to')
    expect(nt).toContain('a kind it does not know')
    expect(NOTIFICATION_MAX_AGE_MS).toBe(60 * 60_000)
    expect(nt).toContain('older than an hour')
    expect(nt).toContain('a line in its log')
    expect(nt).toContain(`cut at ${NOTIFICATION_VALUE_MAX} characters and a title at ${NOTIFICATION_TITLE_MAX}`)
    // 3c final review: the title rules as notifications.ts has them (I2), the shared time limit (M1), and that a failed
    // send hands onEvent the event again (M5)
    expect(nt).toContain('the first line of its objective that holds something')
    // Plugin 4d review M3: a Job made from a ticket is named by the ticket's title
    expect(nt).toContain('the title of the ticket it was made from')
    expect(nt).toContain('else the last part of its folder, else Astera')
    expect(nt).toContain('`onEvent` and `send` share the 30 seconds')
    expect(nt).toContain('`onEvent` included')
    // One row per kind, in NOTIFICATION_KINDS' order, with its level and every sentence it can be
    const rows = sec.split('\n').filter((l) => /^\| `[a-z_]+\.[a-z_]+` \|/.test(l))
    expect(rows.map((l) => /^\| `([^`]+)`/.exec(l)![1])).toEqual([...NOTIFICATION_KINDS])
    const sentences: Record<string, MessageKey[]> = {
      'question.created': ['pluginNotify.questionCreated'],
      'session.input_needed': ['pluginNotify.inputNeeded.permission', 'pluginNotify.inputNeeded.question', 'pluginNotify.inputNeeded'],
      'run.failed': ['pluginNotify.runFailed'],
      'completion.exhausted': ['pluginNotify.completionExhausted'],
      'session.limit_waiting': ['pluginNotify.limitWaitingAt', 'pluginNotify.limitWaiting'],
      'run.completed': ['pluginNotify.runCompleted'],
      'session.account_switched': ['pluginNotify.accountSwitched']
    }
    for (const [i, kind] of NOTIFICATION_KINDS.entries()) {
      expect(rows[i], kind).toContain(`| \`${NOTIFICATION_LEVEL[kind]}\` |`)
      for (const key of sentences[kind]) expect(rows[i], key).toContain(t('en', key))
    }
    const [fragment] = fenced(sec, 'json')
    const parsed = parseManifest({ name: 'x', version: '1.0.0', astera: { apiVersion: '1', entry: 'index.js', ...JSON.parse(fragment) } })
    expect(parsed.ok && parsed.manifest.capabilities).toEqual(['notification'])
    expect(sec).toContain('](../examples/plugins/discord-notifier)')
    expect(read('examples/plugins/discord-notifier/README.md')).toContain('docs/plugins.md#notification-plugins)')
    expect(section(guide, '## Not yet')).not.toContain('`notification`')
  })

  // Plugin Phase 4 J24: the job-source capability as the Host serves it
  it('says how a job source is asked, with the Host’s limits and errors, and the objective it writes', () => {
    const sec = section(guide, '## Job source plugins')
    const js = prose(sec)
    for (const f of ['`listItems`', '`getItem`', '`buildJobContext`', '`defineJobSourceProvider`']) expect(js, f).toContain(f)
    expect(js).toContain(`${JOB_SOURCE_TIMEOUT_MS / 1000} seconds`)
    for (const n of [SOURCE_ITEMS_MAX, SOURCE_ID_MAX, SOURCE_TITLE_MAX, SOURCE_SUMMARY_MAX, SOURCE_CURSOR_MAX, SOURCE_BODY_MAX, SOURCE_FIELDS_MAX, SOURCE_OBJECTIVE_MAX, SOURCE_LABEL_MAX, SOURCE_EVIDENCE_MAX, SOURCE_EVIDENCE_TOTAL_MAX])
      expect(js, String(n)).toContain(n.toLocaleString('en-US'))
    for (const status of ['502', '503', '504']) expect(js, status).toContain(status)
    expect(js).toContain('`<<<SOURCE')
    expect(js).toContain('`source`')
    expect(js).toContain('needs no permission')
    expect(js).toContain('control character')
    // The 4b review's M4: the sentence a person reads, as commandSources words it with what the function threw
    expect(js).toContain('"the Linear source could not list items: 401 Unauthorized"')
    expect(js).toContain('`cut: true`')
    // Its manifest fragment is one Astera reads as a job source
    const [fragment] = fenced(sec, 'json')
    const parsed = parseManifest({ name: 'x', version: '1.0.0', astera: { apiVersion: '1', entry: 'index.js', ...JSON.parse(fragment) } })
    expect(parsed.ok && parsed.manifest.capabilities).toEqual(['job-source'])
    expect(sec).toContain('](../examples/plugins/linear-source)')
    expect(read('examples/plugins/linear-source/README.md')).toContain('docs/plugins.md#job-source-plugins)')
    expect(section(guide, '## Not yet')).not.toContain('`job-source`')
    expect(prose(section(guide, '## The manifest'))).toContain('[Job source plugins](#job-source-plugins)')
    // docs/sdk.md: a Job made from a source carries where it came from, and the 4b review's M10: how an SDK user makes one
    const sdkJobs = prose(section(read('docs/sdk.md'), '### Jobs and Runs'))
    expect(sdkJobs).toContain('`source`')
    expect(sdkJobs).toContain("call('jobs-create-from-source'")
    expect(read('packages/client/CHANGELOG.md')).toContain('`jobs-create-from-source`')
  })

  // Plugin Phase 5 C16: how a completion check is asked, in the constants' own numbers, and the other guides with it
  it('says how a completion check is asked, with the Host’s limits and errors, the question and the repair', () => {
    const sec = section(guide, '## Completion check plugins')
    const cc = prose(sec)
    for (const f of ['`runCheck`', '`defineCompletionCheckProvider`', '`plugin:<id>`', '`passed`', '`failed`', '`error`', '`check-unavailable`', '`PLUGIN_CAPABILITY_MISSING`'])
      expect(cc, f).toContain(f)
    for (const o of CHECK_UNAVAILABLE_OPTIONS) expect(cc, o).toContain(`\`${o}\``)
    // 5d final review M5: the answer's shape names the count a check may give
    expect(cc).toContain('`{ status, summary?, diagnostics?, diagnosticsTotal?, externalUrl? }`')
    for (const n of [CHECK_SUMMARY_MAX, CHECK_DIAGNOSTICS_MAX, CHECK_MESSAGE_MAX, CHECK_FILE_MAX, SOURCE_URL_MAX, REPAIR_DIAGNOSTICS])
      expect(cc, String(n)).toContain(n.toLocaleString('en-US'))
    expect(cc).toContain(`${CHECK_TIMEOUT_MS / 60_000} minutes`)
    // The sentences a person reads, as the Host words them (completionChecks.ts, pluginChecks.ts)
    expect(cc).toContain('"runCheck threw: ')
    expect(cc).toContain('"the plugin answered with something that is not a check result: ')
    expect(cc).toContain('needs no permission')
    expect(cc).toContain('adds no check')
    const [fragment] = fenced(sec, 'json')
    const parsed = parseManifest({ name: 'x', version: '1.0.0', astera: { apiVersion: '1', entry: 'index.js', ...JSON.parse(fragment) } })
    expect(parsed.ok && parsed.manifest.capabilities).toEqual(['completion-check'])
    expect(sec).toContain('](../examples/plugins/debug-leftovers)')
    expect(prose(section(guide, '## The manifest'))).toContain('[Completion check plugins](#completion-check-plugins)')
    expect(prose(section(guide, '## The manifest'))).toContain('a `runCheck` for a completion check')
    expect(guide.split('\n## ')[0]).toContain('(#completion-check-plugins)')
    // The other guides: the id a Task names, the fields a result carries, the question's answers
    const cli = prose(read('docs/cli.md'))
    for (const f of ['`plugin:<id>`', '`skip-check`', '`diagnostics`', '`externalUrl`', '`skipped: true`', 'could not run']) expect(cli, f).toContain(f)
    // 5b final review M7: how a skipped check and one that could not be made count in `runs checks`
    expect(cli).toContain('A check a person skipped counts as passed.')
    expect(cli).toContain('leaves validation `pending` while the task waits on its question, and `failed` once it does not')
    const sdk = prose(read('docs/sdk.md'))
    for (const f of ['`plugin:<id>`', '`check-unavailable`', '`diagnostics`', '`skip-check`']) expect(sdk, f).toContain(f)
    const mcp = prose(read('docs/mcp.md'))
    for (const f of ['plugin:<pluginId>', 'check-unavailable', '`diagnostics`', '`externalUrl`']) expect(mcp, f).toContain(f)
    // 5b final review M9, M10: only a check-unavailable question refuses other answers; a plugin's check has no output
    for (const doc of [sdk, mcp]) expect(doc).toContain('refuses any answer but `retry`, `skip-check` or `mark-failed`')
    for (const doc of [sdk, mcp]) expect(doc).not.toContain('takes one of them')
    expect(mcp).toContain("A plugin's check (`plugin:<pluginId>`) has no output: its findings are in `get_completion`.")
    // 5b final review M14: the guide's count of findings under a row is the renderer's
    expect(cli).toContain(`first ${HUMAN_DIAGNOSTICS} findings`)
  })

  // The design's note on N2: a session event carries its title and folder, so the grant says so
  it('says that events.subscribe hands a plugin the titles and folders of sessions', () => {
    expect(prose(section(guide, '## Permissions'))).toMatch(/`events\.subscribe`[^.]*session[^.]*titles[^.]*folders/)
  })

  it('says which Node a plugin runs on, and how to start Node from process.execPath', () => {
    const node = section(guide, '## The Node a plugin runs on')
    const electron = /(\d+)\./.exec(JSON.parse(read('package.json')).devDependencies.electron as string)![1]
    expect(prose(node)).toContain(`Electron ${electron}`)
    // 2f final review m7, m8: on Windows the Host, and so each plugin, runs on the Node Astera ships for it
    const shipped = /const NODE = \{\s*version: '(\d+\.\d+)\.\d+'/.exec(read('scripts/host-runtime.mjs'))![1]
    expect(prose(node)).toContain(`Node ${shipped}`)
    expect(read('scripts/host-runtime.mjs')).toContain("const HOST_EXE = 'astera-host.exe'")
    expect(prose(node)).toContain('`astera-host.exe`')
    expect(guide).not.toMatch(/Astera 1\.\d/)
    // The launcher takes the switch away before a plugin loads, which is why a plugin must give it back to a child
    expect(read('src/pluginHost/index.ts')).toContain('delete process.env.ELECTRON_RUN_AS_NODE')
    expect(fenced(node, 'js').join('\n')).toContain("ELECTRON_RUN_AS_NODE: '1'")
  })

  // 2f final review m6: a process that exits right after writing a line can lose it where stderr is a pipe written later
  it('ends a process only once its last log line has left', () => {
    const exits = [...fenced(guide, 'ts'), ...fenced(guide, 'js')].filter((b) => b.includes('process.exit('))
    expect(exits.length).toBeGreaterThanOrEqual(1)
    for (const b of exits) expect(b.match(/process\.exit\(/g)!.length, b).toBe(b.match(/process\.stderr\.write\('', \(\) => process\.exit\(/g)?.length ?? 0)
  })

  it('every TypeScript block compiles against the plugin SDK and the client', () => {
    const blocks = fenced(guide, 'ts')
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(typecheckBlocks(blocks)).toBe('')
  }, 60_000)

  it('every link lands on a file, and an anchor on a heading there', () => {
    const links = [...guide.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l))
    expect(links.length).toBeGreaterThan(5)
    for (const l of links) {
      const [file, anchor] = l.split('#')
      const target = file === '' ? path.join(root, 'docs', 'plugins.md') : path.resolve(root, 'docs', file)
      expect(existsSync(target), l).toBe(true)
      if (anchor !== undefined) expect(anchors(readFileSync(target, 'utf8')).has(anchor), l).toBe(true)
    }
  })

  it('links the sample, and the sample links back', () => {
    expect(guide).toContain('](../examples/plugins/webhook-notifier)')
    const sample = read('examples/plugins/webhook-notifier/README.md')
    expect(sample).toContain('docs/plugins.md)')
    // 2f final review m13 and its declined replay note: a signature is compared in constant time, and says nothing of
    // whether a post is new
    expect(sample).toContain('timingSafeEqual')
    expect(sample).toContain('`event.id`')
    // Plugin Phase 3: an event plugin is handed what happened while it was stopped, a crash's restart included
    expect(prose(sample)).toContain('what happened while it was stopped')
    expect(prose(sample)).toContain('after it first starts')
    expect(prose(sample)).toContain('starting again after a crash')
    expect(prose(sample)).not.toContain('is not posted')
  })

  // 2f final review m1: the quick start's commands need the astera command
  it('says where the astera command comes from before the quick start uses it', () => {
    expect(section(guide, '## Quick start')).toContain('](cli.md#install)')
  })

  it('is reached from the CLI and SDK guides, the README and the plugin SDK’s README, and the SDK no longer lists plugins as missing', () => {
    expect(read('docs/cli.md')).toContain('](plugins.md)')
    expect(read('docs/sdk.md')).toContain('](plugins.md)')
    expect(section(read('docs/sdk.md'), '## Not yet')).not.toMatch(/Plugins/)
    expect(read('README.md')).toContain('](docs/plugins.md)')
    expect(read('packages/plugin-sdk/README.md')).toContain('docs/plugins.md')
  })

  it('is published: docs/ is a gitignore whitelist, and the guide is on it', () => {
    // git check-ignore exits 1 when nothing ignores the path
    let status: unknown = 0
    try {
      execFileSync('git', ['check-ignore', '-q', 'docs/plugins.md'], { cwd: root, stdio: 'ignore' })
    } catch (e) {
      status = (e as { status?: unknown }).status
    }
    expect(status).toBe(1)
  })
})

describe('the quick start, followed as written', () => {
  let work: string
  let launcher: string
  beforeAll(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), 'astera-quick start '))
    launcher = await bundleLauncher(work)
  }, 60_000)
  afterAll(async () => {
    await removeFixture(work)
  })

  const runtimes: ReturnType<typeof createPluginRuntime>[] = []
  afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.stopAll()
  })
  /** A runtime whose Host answers projects-list with two projects, and the log of the plugin `id` in it. */
  const runtime = (id: string) => {
    const r = createPluginRuntime({
      profileDir: path.join(work, `profile ${runtimes.length}`),
      exec: process.execPath,
      launcher,
      env: process.env,
      host: () => ({ version: '9.9.9', pid: process.pid, startedAt: 'T', features: ['orch', 'requests', 'events'] }),
      orch: {
        call: (async (a: { cmd: string }) =>
          a.cmd === 'projects-list' ? { status: 200, body: [{ id: 'p1', path: '/a' }, { id: 'p2', path: '/b' }] } : { status: 404, body: { error: `no ${a.cmd}` } }) as never
      },
      log: () => {}
    })
    runtimes.push(r)
    return { r, log: () => (existsSync(r.logFile(id)) ? readFileSync(r.logFile(id), 'utf8') : '') }
  }

  // 2f final review I1: esbuild's ESM output turns a CommonJS dependency's require('events') into a stub that throws
  it('bundles, with the guide’s command, a plugin with a CommonJS dependency into one file that runs', async () => {
    const command = fenced(section(guide, '### TypeScript, and bundling'), 'sh')
      .join('\n')
      .split('\n')
      .find((l) => l.startsWith('npx esbuild '))!
    const outfile = /--outfile=(\S+)/.exec(command)![1]
    const dir = path.join(work, 'bundled')
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules', 'cjs-dep'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'cjs-dep', 'package.json'), JSON.stringify({ name: 'cjs-dep', version: '1.0.0', main: 'index.js' }))
    writeFileSync(path.join(dir, 'node_modules', 'cjs-dep', 'index.js'), "const { EventEmitter } = require('events')\nmodule.exports = () => typeof EventEmitter\n")
    writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      "import kind from 'cjs-dep'\nexport default { activate(ctx: { log: { info(m: string): void } }) { ctx.log.info(`bundled ${kind()}`) } }\n"
    )
    // As a reader runs it, with this repository's esbuild first on the PATH (`npx esbuild` in a folder of its own would
    // fetch one), through the shell: bin/esbuild is a script on Windows and a native program on macOS and Linux
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const PATH = `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env[pathKey] ?? ''}`
    execSync(command.replace(/^npx /, ''), { cwd: dir, stdio: 'pipe', env: { ...process.env, [pathKey]: PATH } })
    const { r, log } = runtime('bundled')
    r.start({ id: 'bundled', version: '1.0.0', folder: 'bundled', dir, entry: path.join(dir, outfile), granted: [], capabilities: [], settings: {}, redact: [] })
    await expect.poll(log, { timeout: 20_000, interval: 50 }).toContain('[info] bundled function')
  }, 40_000)

  it('is a plugin Astera installs and runs, and its log says what the guide says it will', async () => {
    const start = section(guide, '## Quick start')
    const [pkgText] = fenced(start, 'json')
    const [code] = fenced(start, 'js')
    const parsed = parseManifest(JSON.parse(pkgText))
    if (!parsed.ok) throw new Error(parsed.problems.join('; '))
    const m = parsed.manifest
    for (const command of fenced(start, 'sh').join('\n').split('\n').filter((l) => l.startsWith('astera plugins ') && l.includes('--id')))
      expect(command, command).toContain(`--id ${m.id}`)
    const dir = path.join(work, m.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), pkgText)
    writeFileSync(path.join(dir, m.entry), code)

    const { r, log } = runtime(m.id)
    r.start({ id: m.id, version: m.version, folder: m.id, dir, entry: path.join(dir, m.entry), granted: m.permissions, capabilities: m.capabilities, settings: {}, redact: [] })
    // The log lines the guide shows, without their times and the process id
    const shown = fenced(start, 'text')
      .join('\n')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.replace(/^\S+ /, '').replace(/pid \d+/, 'pid '))
    expect(shown.length).toBeGreaterThanOrEqual(2)
    await expect
      .poll(() => log().replace(/pid \d+/g, 'pid '), { timeout: 20_000, interval: 50 })
      .toSatisfy((text: string) => shown.every((l) => text.includes(l)))
  }, 40_000)
})

// 5b final review I3: the guide's completion check is one a worker can satisfy. Run as written in the real runtime, it
// passes a Task that adds a new migration as told, fails one that changes an old one, reads a Task folder inside a
// larger repository, and throws one sentence when git fails.
describe('the completion check example, run as written', () => {
  let work: string
  let launcher: string
  beforeAll(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), 'astera-check example '))
    launcher = await bundleLauncher(work)
  }, 60_000)
  afterAll(async () => {
    await removeFixture(work)
  })
  const runtimes: ReturnType<typeof createPluginRuntime>[] = []
  afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.stopAll()
  })

  it('passes a new migration, fails a changed one, reads a subfolder, and throws one sentence', async () => {
    const [block] = fenced(section(guide, '## Completion check plugins'), 'ts')
    const sdk = "import { defineCompletionCheckProvider } from '@astera-app/plugin-sdk'"
    expect(block).toContain(sdk)
    // The SDK's function is the provider it is given; the rest is the block as a reader writes it
    const ts = block.replace(sdk, 'const defineCompletionCheckProvider = <T,>(provider: T): T => provider')
    const dir = path.join(work, 'example')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.mjs'), (await transform(ts, { loader: 'ts', format: 'esm', target: 'node22' })).code)
    const r = createPluginRuntime({
      profileDir: path.join(work, 'profile'),
      exec: process.execPath,
      launcher,
      env: process.env,
      host: () => ({ version: '9.9.9', pid: process.pid, startedAt: 'T', features: ['orch', 'requests', 'events'] }),
      orch: { call: (async (a: { cmd: string }) => ({ status: 404, body: { error: `no ${a.cmd}` } })) as never },
      log: () => {}
    })
    runtimes.push(r)
    r.start({ id: 'example', version: '1.0.0', folder: 'example', dir, entry: path.join(dir, 'index.mjs'), granted: [], capabilities: ['completion-check'], settings: {}, redact: [] })
    await expect.poll(() => r.status('example')?.status, { timeout: 45_000, interval: 50 }).toBe('running')
    const ask = (root: string, base?: string) =>
      r.request('example', 'completionCheck.run', { input: { jobId: 'j', runId: 'r', taskId: 't', task: { title: 'x' }, workspace: { root, ...(base ? { base } : {}) } } }, 60_000) as Promise<{
        status: string
        summary: string
        diagnostics?: Array<{ file: string }>
      }>

    const repo = await tempDir('astera-check example repo ')
    try {
      gitSync(repo, ['init', '-b', 'main'])
      gitSync(repo, ['config', 'user.email', 't@t.com'])
      gitSync(repo, ['config', 'user.name', 'Test User'])
      mkdirSync(path.join(repo, 'db', 'migrations'), { recursive: true })
      writeFileSync(path.join(repo, 'db', 'migrations', '001 première.sql'), 'create table a (id int);\n')
      gitSync(repo, ['add', '-A'])
      gitSync(repo, ['commit', '-m', 'base'])
      const base = gitSync(repo, ['rev-parse', 'HEAD'])
      const db = path.join(repo, 'db')
      // A new migration, committed, is how the worker was told to change the schema
      writeFileSync(path.join(repo, 'db', 'migrations', '002.sql'), 'alter table a add b int;\n')
      gitSync(repo, ['add', '-A'])
      gitSync(repo, ['commit', '-m', 'work'])
      expect(await ask(db, base)).toMatchObject({ status: 'passed' })
      // Changing an old one is what it fails, named from the Task's folder as it is on disk
      writeFileSync(path.join(repo, 'db', 'migrations', '001 première.sql'), 'create table a (id bigint);\n')
      expect(await ask(db, base)).toEqual({
        status: 'failed',
        summary: 'a migration was changed: add a new one instead',
        diagnostics: [{ file: 'migrations/001 première.sql', message: 'changes a migration that may have run already' }]
      })
      // git failing is one sentence, as the guide tells a plugin to throw
      const failed = await ask(db, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef').then(
        () => null,
        (e: unknown) => e
      )
      expect(failed).toBeInstanceOf(PluginRequestFailed)
      expect((failed as Error).message).toMatch(/^runCheck threw: git could not list the changes: fatal: bad (object|revision)/)
      expect((failed as Error).message).not.toContain('\n')
    } finally {
      await removeFixture(repo)
    }
  }, 120_000)
})
