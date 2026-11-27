// `astera plugins dev` (Plugin Platform V2, Phase 2 step 4b, spec E4 dev): install a plugin folder once with the person's
// approval, as `plugins install` does, then watch it and, once a change has settled, check it and install it again with
// the grant first approved. A folder with problems is not installed; one that asks for anything new (a permission, a
// capability, another trust level) waits for the person to run dev again, so dev never grants what nobody approved. Stopping
// leaves the last install in place (the person's decision, 2026-11-25). Main notices each reinstall and an open panel
// takes the new page by itself (main/plugins/panelGuests.ts, PluginPanelTab.tsx).
import path from 'node:path'
import chokidar from 'chokidar'
import { codeForStatus, type CliError } from '../core/orchestration/cliOutput'
import { PLUGIN_SERVED_CAPABILITIES, parseManifest } from '../core/plugins/manifest'
import { checkPluginFolder, type FolderCheck, type FolderProblem } from '../host/plugins/folderCheck'
import { readPackage } from '../host/plugins/packageFile'
import { logToStderr } from './host'
import { approvalMessage, installPlugin, type PluginCall } from './plugins'

/** What a plugin asks for: what an approval covers. */
export interface PluginAsks {
  permissions: string[]
  capabilities: string[]
  trust: string
}

export type DevEvent =
  | { event: 'installed'; version: string; at: string }
  | { event: 'watching'; folder: string }
  | { event: 'problems'; problems: FolderProblem[] }
  | { event: 'needsApproval'; asks: PluginAsks }
  | { event: 'failed'; message: string }

/** How long the folder must be quiet before it is checked: an editor's save is several writes. */
const QUIET_MS = 300

/** One event as the sentence `--human` prints. */
export function devEventLine(e: DevEvent): string {
  switch (e.event) {
    case 'installed':
      return `installed ${e.version} at ${e.at}`
    case 'watching':
      return `watching ${e.folder}; Ctrl+C stops and leaves the last install in place`
    case 'problems':
      return `not installed: ${e.problems.map((p) => `${p.code}${p.field !== undefined ? ` ${p.field}` : ''}: ${p.message}`).join('; ')}`
    case 'needsApproval': {
      const asks = [...e.asks.permissions, ...e.asks.capabilities.map((c) => `the ${c} capability`)]
      const trust = e.asks.trust === 'trusted' ? 'trusted code' : e.asks.trust === 'declarative' ? 'themes only' : 'restricted UI'
      return `not installed: it now asks for ${asks.length > 0 ? asks.join(', ') : 'nothing'} as ${trust}; stop dev and run it again to approve that`
    }
    case 'failed':
      return `not installed: ${e.message}`
  }
}

/** An editor's side file: vim's swap and backup files and its 4913 write test, Emacs' lock links and autosaves. */
const EDITOR_SIDE_FILE = /^(?:\..*\.sw[a-p]|.*~|\.#.*|#.*#|4913)$/

/** Whether a path under the plugin folder (with / or \\) makes no round: .git, node_modules, an editor's side files. */
export function ignoredByDev(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  return parts.some((part) => part === '.git' || part === 'node_modules') || EDITOR_SIDE_FILE.test(parts[parts.length - 1])
}

/** The folder watched as main's watchers watch theirs (main/fileWatcher.ts): no event for what is already there, a file
 *  reported once its writes have settled, and what ignoredByDev names not looked at. A watcher error is said, not a crash. */
export function chokidarWatch(folder: string, onChange: () => void): () => void {
  const watcher = chokidar.watch(folder, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string) => p !== folder && ignoredByDev(path.relative(folder, p))
  })
  watcher.on('all', () => onChange())
  watcher.on('error', (e: unknown) => logToStderr(`plugins dev: watching ${folder} failed: ${e instanceof Error ? e.message : String(e)}`))
  return () => void watcher.close()
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

/** Watches `folder` and installs it again as it changes. One round at a time: a change during one makes one more after
 *  it, with the folder as it is then. `idle` resolves once nothing is waiting or running (for tests). */
export function watchPluginFolder(d: {
  folder: string
  approved: PluginAsks & { grant: string[] }
  check: (folder: string) => Promise<FolderCheck>
  asks: (folder: string) => Promise<PluginAsks | null>
  install: (grant: string[]) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }>
  watch: (folder: string, onChange: () => void) => () => void
  emit: (e: DevEvent) => void
  now?: () => Date
  quietMs?: number
}): { stop(): void; poke(): void; idle(): Promise<void> } {
  const now = d.now ?? (() => new Date())
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let again = false
  let stopped = false

  const round = async (): Promise<void> => {
    const checked = await d.check(d.folder)
    if (checked.problems.length > 0) return d.emit({ event: 'problems', problems: checked.problems })
    const asks = await d.asks(d.folder)
    if (asks === null) return d.emit({ event: 'failed', message: `${path.join(d.folder, 'package.json')} could not be read` })
    if (!sameSet(asks.permissions, d.approved.permissions) || !sameSet(asks.capabilities, d.approved.capabilities) || asks.trust !== d.approved.trust)
      return d.emit({ event: 'needsApproval', asks: { permissions: asks.permissions, capabilities: asks.capabilities, trust: asks.trust } })
    const r = await d.install(d.approved.grant)
    if (!r.ok) return d.emit({ event: 'failed', message: r.message })
    d.emit({ event: 'installed', version: String(r.body.version ?? ''), at: now().toISOString() })
  }

  const go = (): void => {
    timer = null
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = round()
      .catch((e: unknown) => d.emit({ event: 'failed', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        running = null
        if (again && !stopped) {
          again = false
          go()
        }
      })
  }

  const changed = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(go, d.quietMs ?? QUIET_MS)
  }
  const unwatch = d.watch(d.folder, changed)

  return {
    /** As if the folder had just changed. */
    poke: changed,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      unwatch()
    },
    async idle() {
      while (timer !== null || running !== null) await (running ?? new Promise((r) => setTimeout(r, 0)))
    }
  }
}

/** What the folder's package.json asks for, or null when it does not read as a manifest. */
async function asksOf(folder: string): Promise<PluginAsks | null> {
  const read = await readPackage(folder)
  if (!read.ok) return null
  const parsed = parseManifest(read.pkg)
  return parsed.ok ? { permissions: [...parsed.manifest.permissions], capabilities: [...parsed.manifest.capabilities], trust: parsed.manifest.trust } : null
}

/** A Host answer as one sentence. */
const messageOf = (r: PluginCall): string =>
  'unreachable' in r
    ? r.unreachable
    : 'stuck' in r
      ? r.stuck
      : typeof (r.body as { error?: unknown } | null)?.error === 'string'
        ? ((r.body as { error: string }).error)
        : `the Host answered ${r.status}`

/** The whole command: the first install with the person's approval, then the watch until `onStop` is called. Ends with
 *  the first install's refusal, or ok once stopped. */
export async function runPluginDev(d: {
  args: Record<string, unknown>
  cwd: string
  version: string
  call: (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<PluginCall>
  watch: (folder: string, onChange: () => void) => () => void
  emit: (e: DevEvent) => void
  onStop: (stop: () => void) => void
  now?: () => Date
  check?: (folder: string) => Promise<FolderCheck>
  asks?: (folder: string) => Promise<PluginAsks | null>
}): Promise<{ ok: true } | { ok: false; error: CliError }> {
  if (typeof d.args.path !== 'string' || d.args.path === '') return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'plugins dev needs --path <folder>' } }
  const folder = path.resolve(d.cwd, d.args.path)
  // Watched from before the first install, so a save made while it runs is installed after it (final review M8)
  let early = false
  const unwatchEarly = d.watch(folder, () => {
    early = true
  })
  const first = await installPlugin({ args: { ...d.args, path: folder }, cwd: d.cwd, request: undefined, call: d.call }).finally(unwatchEarly)
  if ('approve' in first) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: approvalMessage(first.approve), details: { plugin: first.approve } } }
  if ('unreachable' in first) return { ok: false, error: { code: 'HOST_NOT_RUNNING', message: first.unreachable } }
  if ('stuck' in first) return { ok: false, error: { code: 'TIMEOUT', message: first.stuck } }
  if (first.status !== 200) return { ok: false, error: { code: codeForStatus(first.status), message: messageOf(first) } }
  const body = (first.body ?? {}) as Record<string, unknown>
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const approved = { grant: strings(body.permissions), permissions: strings(body.requested), capabilities: strings(body.capabilities), trust: String(body.trust ?? '') }
  const now = d.now ?? (() => new Date())
  d.emit({ event: 'installed', version: String(body.version ?? ''), at: now().toISOString() })

  const w = watchPluginFolder({
    folder,
    approved,
    check: d.check ?? ((f) => checkPluginFolder(f, { version: d.version, capabilities: PLUGIN_SERVED_CAPABILITIES })),
    asks: d.asks ?? asksOf,
    install: async (grant) => {
      // What was approved goes with the install: the Host refuses a copy of another trust, and a folder asking for anything
      // else is refused before it is sent (final review I5)
      const held = { trust: approved.trust, permissions: approved.permissions, capabilities: approved.capabilities }
      const r = await installPlugin({ args: { path: folder, grant: grant.join(',') }, cwd: d.cwd, request: undefined, call: d.call, approved: held })
      if ('approve' in r) return { ok: false, message: approvalMessage(r.approve) }
      if ('status' in r && r.status === 200) return { ok: true, body: (r.body ?? {}) as Record<string, unknown> }
      return { ok: false, message: messageOf(r as PluginCall) }
    },
    watch: d.watch,
    emit: d.emit,
    now
  })
  d.emit({ event: 'watching', folder })
  if (early) w.poke()
  await new Promise<void>((resolve) =>
    d.onStop(() => {
      w.stop()
      resolve()
    })
  )
  return { ok: true }
}
