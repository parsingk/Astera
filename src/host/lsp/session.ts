// One language server process (Phase 3 Part 3): how it is launched (`lspLaunch`), and a session that starts it, opens the
// app's files in it, takes its problems, answers what it asks, and stops it. Measured 2026-11-26
// (F:\astera-work\scratch\phase3\measure-lsp.md):
// - TypeScript 7 runs as its own executable with `--lsp --stdio` and gives problems only when pulled; it pushes its
//   tsconfig errors for files never opened; it refuses `shutdown` with `"params": null` and exits 1 after a clean one.
// - typescript-language-server runs on the Host's Node and pushes; without a `tsserver.path` that exists it runs the
//   project's own TypeScript, so its launch is refused unless the pinned one is there.
// - pyright runs on the Host's Node, reads its settings only through `workspace/configuration`, pulls once it has
//   registered `textDocument/diagnostic`, and is never left to find `python` itself (see core/lsp/servers.ts).
// - Neither server reads a file again on `didSave`, so a changed file is sent as `didClose` then `didOpen` with the new
//   text and the next version; no `didChange` is ever sent. Problems for an older version are dropped.
// The server's stderr and `window/logMessage` go to its log within a budget (the plugin runtime's: 1000 lines and
// 1 MiB a second); an exit that was not asked for is a crash, one after `shutdown`/`exit` never is.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { hostWorkerBaseEnv } from '../../core/host/spawn'
import { killProcessTree } from '../../core/run/kill'
import { isUnder } from '../../core/context/contextRef'
import { foldPathCase } from '../../core/files/paths'
import { createLspClient } from '../../core/lsp/client'
import { toProblems } from '../../core/lsp/convert'
import { pathToUri, uriToPath } from '../../core/lsp/uri'
import { pyrightConfiguration, pythonPathFor, serverPackages } from '../../core/lsp/servers'
import type { LanguageServerSettings, LspProblem, LspServerId } from '../../core/lsp/model'
import { openHostLog } from '../log'
import { lspDir, packageDir } from './install'

export interface LspTimings {
  /** How long `initialize` may take. */
  initializeMs: number
  /** How long a pull may take. */
  pullMs: number
  /** How long a stopping server has after `exit`, and again after the kill. */
  stopGraceMs: number
}

export const LSP_TIMINGS: LspTimings = { initializeMs: 30_000, pullMs: 30_000, stopGraceMs: 3_000 }

/** The log budget a second, and the log file's size. */
export const LSP_LOG_LINES_PER_SECOND = 1_000
export const LSP_LOG_CHARS_PER_SECOND = 1_048_576
export const LSP_LOG_MAX_BYTES = 1_048_576

export interface LspLaunch {
  server: LspServerId
  root: string
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  initializationOptions?: unknown
  /** The answer to one `workspace/configuration` item. */
  configuration?: (section: string, scopeUri?: string) => unknown
  log: string
  /** Folders made before the spawn (typescript-language-server's TEMP). */
  ensureDirs?: string[]
  /** Problem codes never passed on: pyright's missing-import ones when it has no interpreter, since a project's own
   *  pyright config makes it skip the overrides that turn them off (final review I2). */
  dropCodes?: string[]
  /** It is told of files changed on disk (`workspace/didChangeWatchedFiles`): pyright watches nothing itself (final review
   *  I3). TypeScript 7 watches the disk on its own and is not offered this. */
  watchFiles?: true
}

/** The environment a server starts with: the Host's own without what is the Host's alone and without any ASTERA_
 *  variable, and with Windows told never to look in the current folder for a program (a second guard beside pyright's
 *  absolute interpreter). */
function serverEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(hostWorkerBaseEnv(env))) if (!/^ASTERA_/i.test(k)) out[k] = v
  return { ...out, NoDefaultCurrentDirectoryInExePath: '1', ...extra }
}

/** Why a server cannot run: its files are not there (`not-installed`), or another reason. */
export interface LspRefused {
  refused: string
  why: 'not-installed' | 'refused'
}

/** A server's log for a root: `<profile>/language-servers/logs/<server>-<8 hex of the folded root's sha256>.log`. */
export function lspLogFile(profileDir: string, server: LspServerId, root: string, platform: string = process.platform): string {
  return path.join(lspDir(profileDir), 'logs', `${server}-${createHash('sha256').update(foldPathCase(root, platform)).digest('hex').slice(0, 8)}.log`)
}

/** How a server runs for a root, or why it cannot: its files must be where Astera installed them, or where the person's
 *  setting says, and the root must be a folder a file URI can name. */
export function lspLaunch(d: {
  server: LspServerId
  root: string
  profileDir: string
  /** The Host's own executable, which runs typescript-language-server and pyright as Node. */
  exec: string
  env: NodeJS.ProcessEnv
  settings: LanguageServerSettings
  pythonPath?: { pythonPath: string; missingImportsOff: boolean }
  platform?: string
  arch?: string
  exists?: (p: string) => boolean
  /** For tests: how a package.json is read. */
  readText?: (p: string) => string
}): LspLaunch | LspRefused {
  const platform = d.platform ?? process.platform
  const exists = d.exists ?? existsSync
  const readText = d.readText ?? ((p: string): string => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  })
  if (pathToUri(d.root, platform) === null) return { refused: `a server cannot be pointed at ${d.root}`, why: 'refused' }
  const log = lspLogFile(d.profileDir, d.server, d.root, platform)
  const missing = (p: string): LspRefused => ({ refused: `not installed: ${p} is missing`, why: 'not-installed' })
  const pins = serverPackages(d.server, platform, d.arch ?? process.arch)
  if (d.server === 'typescript') {
    if (!d.settings.typescript.path && pins === null) return { refused: `there is no TypeScript 7 package for ${platform} ${d.arch ?? process.arch}`, why: 'refused' }
    const file = d.settings.typescript.path ?? path.join(packageDir(d.profileDir, pins![0]), 'lib', platform === 'win32' ? 'tsc.exe' : 'tsc')
    if (!exists(file)) return missing(file)
    return { server: d.server, root: d.root, file, args: ['--lsp', '--stdio'], env: serverEnv(d.env, {}), log }
  }
  if (d.server === 'typescript5') {
    const cli = path.join(packageDir(d.profileDir, pins![0]), 'lib', 'cli.mjs')
    const tsserver = path.join(packageDir(d.profileDir, pins![1]), 'lib', 'tsserver.js')
    if (!exists(cli)) return missing(cli)
    if (!exists(tsserver)) return missing(tsserver)
    // typescript-language-server reads this package.json and, when it is not a TypeScript, runs the project's own; the
    // pinned version is checked at every launch, crash restarts too (final review M14)
    const tsPackage = path.join(path.dirname(path.dirname(tsserver)), 'package.json')
    let version: unknown
    try {
      version = (JSON.parse(readText(tsPackage)) as { version?: unknown }).version
    } catch {
      version = undefined
    }
    if (version !== pins![1].version) return { refused: `not installed: ${tsPackage} is not TypeScript ${pins![1].version}`, why: 'not-installed' }
    const tmp = path.join(lspDir(d.profileDir), 'tmp')
    return {
      server: d.server,
      root: d.root,
      file: d.exec,
      args: [cli, '--stdio'],
      env: serverEnv(d.env, { ELECTRON_RUN_AS_NODE: '1', TEMP: tmp, TMP: tmp }),
      initializationOptions: { tsserver: { path: tsserver }, disableAutomaticTypingAcquisition: true },
      log,
      ensureDirs: [tmp]
    }
  }
  const entry = d.settings.python.path ?? path.join(packageDir(d.profileDir, pins![0]), 'langserver.index.js')
  if (!exists(entry)) return missing(entry)
  const python = d.pythonPath ?? pythonPathFor(null, d.profileDir)
  return {
    server: d.server,
    root: d.root,
    file: d.exec,
    args: [entry, '--stdio'],
    env: serverEnv(d.env, { ELECTRON_RUN_AS_NODE: '1' }),
    configuration: (section) => pyrightConfiguration(section, python),
    log,
    watchFiles: true,
    ...(python.missingImportsOff ? { dropCodes: ['reportMissingImports', 'reportMissingModuleSource'] } : {})
  }
}

export interface LspSession {
  readonly pid: number | undefined
  open(path: string, text: string): void
  close(path: string): void
  /** A file it has not open changed on disk (final review I3): told as `workspace/didChangeWatchedFiles` to a server
   *  launched with `watchFiles`, nothing to another. */
  changed(path: string, kind: 'created' | 'changed' | 'deleted'): void
  shutdown(): Promise<void>
}

const LANGUAGE_ID: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  pyi: 'python'
}
const languageIdOf = (p: string): string => LANGUAGE_ID[path.extname(p).slice(1).toLowerCase()] ?? 'plaintext'

/** What Astera offers a server: UTF-16 positions only, configuration and refresh answered, pull diagnostics through a
 *  dynamic registration (pyright needs the flag), versioned pushes, progress tokens, and watched files to a server
 *  launched to be told of them. */
const clientCapabilities = (l: LspLaunch): unknown => ({
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    diagnostics: { refreshSupport: true },
    ...(l.watchFiles ? { didChangeWatchedFiles: { dynamicRegistration: true } } : {})
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    diagnostic: { dynamicRegistration: true },
    publishDiagnostics: { versionSupport: true }
  },
  window: { workDoneProgress: true }
})

/** A file a server reports on its own that is not open: a tsconfig or jsconfig (TypeScript 7's config errors). Any other
 *  is left out: a closed file's late answer, or a flood of URIs (final review M4). */
const CONFIG_FILE = /^[tj]sconfig[^/\\]*\.json$/i

/** The longest stderr line kept; a longer one is cut rather than kept growing (final review M10). */
const STDERR_LINE_MAX = 64 * 1024

/** Elsewhere than Windows, what is left of a server's process group once it exited: SIGTERM, then SIGKILL after a grace
 *  (the plugin runtime's endGroup, final review M11). A group with nothing left in it is no error. */
function endProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, 2_000).unref()
}

interface Doc {
  path: string
  uri: string
  version: number
  text: string
}

export function startLspSession(
  l: LspLaunch,
  d: {
    spawn?: typeof nodeSpawn
    timings?: Partial<LspTimings>
    onDiagnostics(path: string, problems: LspProblem[]): void
    onReady(): void
    onExit(why: { crashed: boolean; reason: string }): void
    /** Something the person should see on the server's status: a pull that did not answer twice. */
    onTrouble?(reason: string): void
    platform?: string
    now?: () => number
    /** For tests: how what is left of a process group is ended elsewhere than Windows. */
    endGroup?: (pid: number) => void
  }
): LspSession {
  const t: LspTimings = { ...LSP_TIMINGS, ...d.timings }
  const platform = d.platform ?? process.platform
  const now = d.now ?? Date.now
  const key = (p: string): string => foldPathCase(p, platform)
  const docs = new Map<string, Doc>()

  // The log, within its budget
  const file = openHostLog({ path: l.log, maxBytes: LSP_LOG_MAX_BYTES })
  let windowStart = 0
  let lines = 0
  let chars = 0
  let dropped = 0
  const sayDropped = (): void => {
    if (dropped === 0) return
    file.write(`dropped ${dropped} line${dropped === 1 ? '' : 's'} of its output: more than ${LSP_LOG_LINES_PER_SECOND.toLocaleString('en-US')} lines or ${LSP_LOG_CHARS_PER_SECOND.toLocaleString('en-US')} characters a second`)
    dropped = 0
  }
  const say = (text: string): void => {
    const at = now()
    if (at - windowStart >= 1000) {
      sayDropped()
      windowStart = at
      lines = 0
      chars = 0
    }
    if (lines >= LSP_LOG_LINES_PER_SECOND || chars + text.length > LSP_LOG_CHARS_PER_SECOND) {
      dropped++
      return
    }
    lines++
    chars += text.length
    file.write(text)
  }

  let ready = false
  let stopping = false
  let finished = false
  let crashReason: string | null = null
  let pulls = false
  /** One version counter for the whole session: a document closed and opened again never reuses one (final review M5). */
  let nextVersion = 0
  const droppedCodes = new Set(l.dropCodes ?? [])
  const kept = (problems: LspProblem[]): LspProblem[] =>
    droppedCodes.size === 0 ? problems : problems.filter((x) => x.code === undefined || !droppedCodes.has(x.code))
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((r) => (resolveExit = r))

  let proc: ChildProcess | null = null
  const killTree = (): void => {
    if (!proc) return
    if (platform === 'win32') return killProcessTree(proc)
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  const finish = (why: { crashed: boolean; reason: string }): void => {
    if (finished) return
    finished = true
    client.close(why.reason)
    say(`ended: ${why.reason}`)
    sayDropped()
    file.close()
    resolveExit()
    d.onExit(why)
  }

  /** A pull that does not answer is asked once more; a second silence goes on the server's status (final review M3). */
  const pull = (doc: Doc, again = true): void => {
    const asked = doc.version
    client.request('textDocument/diagnostic', { textDocument: { uri: doc.uri } }, { timeoutMs: t.pullMs }).then(
      (res) => {
        const cur = docs.get(key(doc.path))
        if (!cur || cur.version !== asked) return
        const r = (typeof res === 'object' && res !== null ? res : {}) as { kind?: unknown; items?: unknown }
        if (r.kind === 'unchanged') return
        d.onDiagnostics(cur.path, kept(toProblems(r.items)))
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        say(`pull of ${doc.path} failed: ${message}`)
        const cur = docs.get(key(doc.path))
        if (!cur || cur.version !== asked || finished || stopping) return
        if (again && (e as { code?: unknown })?.code === 'timeout') return pull(cur, false)
        d.onTrouble?.(`a pull of ${doc.path} did not answer: ${message}`)
      }
    )
  }
  const pullAll = (): void => {
    if (ready && pulls) for (const doc of docs.values()) pull(doc)
  }
  // A burst of refreshes (TypeScript 7 sends one per disk change) pulls once (final review M10)
  let pullTimer: ReturnType<typeof setTimeout> | null = null
  const pullAllSoon = (): void => {
    if (pullTimer) return
    pullTimer = setTimeout(() => {
      pullTimer = null
      pullAll()
    }, 50)
  }

  const sendOpen = (doc: Doc): void => {
    client.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: languageIdOf(doc.path), version: doc.version, text: doc.text } })
    if (pulls) pull(doc)
  }

  const onPush = (params: unknown): void => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as { uri?: unknown; version?: unknown; diagnostics?: unknown }
    if (typeof p.uri !== 'string') return
    const named = uriToPath(p.uri, platform)
    if (named === null) return
    const doc = docs.get(key(named))
    if (doc) {
      if (typeof p.version === 'number' && p.version !== doc.version) return
      d.onDiagnostics(doc.path, kept(toProblems(p.diagnostics)))
      return
    }
    // A file never opened: only a tsconfig or jsconfig inside the root (TypeScript 7's config errors)
    if (CONFIG_FILE.test(path.basename(named)) && isUnder(l.root, named)) d.onDiagnostics(named, kept(toProblems(p.diagnostics)))
  }

  const onRequest = (method: string, params: unknown): unknown => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
    switch (method) {
      case 'workspace/configuration':
        return (Array.isArray(p.items) ? p.items : []).map((item: unknown) => {
          const i = (typeof item === 'object' && item !== null ? item : {}) as { section?: unknown; scopeUri?: unknown }
          return l.configuration?.(typeof i.section === 'string' ? i.section : '', typeof i.scopeUri === 'string' ? i.scopeUri : undefined) ?? null
        })
      case 'client/registerCapability':
        if (Array.isArray(p.registrations) && p.registrations.some((r: unknown) => (r as { method?: unknown } | null)?.method === 'textDocument/diagnostic')) {
          const was = pulls
          pulls = true
          if (!was) pullAllSoon()
        }
        return null
      case 'workspace/diagnostic/refresh':
        pullAllSoon()
        return null
      default:
        // client/unregisterCapability, window/workDoneProgress/create, window/showMessageRequest and the rest
        return null
    }
  }

  const onNotification = (method: string, params: unknown): void => {
    if (method === 'textDocument/publishDiagnostics') return onPush(params)
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const p = (typeof params === 'object' && params !== null ? params : {}) as { message?: unknown }
      if (typeof p.message === 'string') for (const line of p.message.split('\n')) say(`[log] ${line}`)
    }
  }

  const { client, feed } = createLspClient(
    { write: (b) => proc?.stdin?.write(b) },
    {
      timeoutMs: t.pullMs,
      onRequest,
      onNotification,
      onClosed: (reason) => {
        if (stopping || finished) return
        crashReason = reason
        killTree()
      }
    }
  )

  try {
    for (const dir of l.ensureDirs ?? []) mkdirSync(dir, { recursive: true })
    proc = (d.spawn ?? nodeSpawn)(l.file, l.args, {
      cwd: l.root,
      env: l.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Elsewhere than Windows, the leader of a process group, so a stop ends what the server started too
      detached: platform !== 'win32'
    })
  } catch (e) {
    queueMicrotask(() => finish({ crashed: true, reason: `it could not be started: ${e instanceof Error ? e.message : String(e)}` }))
    return { pid: undefined, open: () => {}, close: () => {}, changed: () => {}, shutdown: async () => {} }
  }
  const pid = proc.pid
  say(`started pid ${proc.pid ?? '?'}: ${l.file} ${l.args.join(' ')}`)
  proc.stdout?.on('data', (chunk: Buffer) => feed(chunk))
  let partial = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = partial + chunk.toString('utf8')
    const parts = text.split('\n')
    partial = parts.pop() ?? ''
    for (const line of parts) say(`[stderr] ${line.replace(/\r$/, '')}`)
    if (partial.length > STDERR_LINE_MAX) {
      say(`[stderr] ${partial.slice(0, STDERR_LINE_MAX)}… (cut)`)
      partial = ''
    }
  })
  proc.stdin?.on('error', () => {
    // A server that went: its exit says so
  })
  proc.on('error', (e) => finish({ crashed: true, reason: `it could not be started: ${e.message}` }))
  proc.on('exit', (code, signal) => {
    if (platform !== 'win32' && pid !== undefined) (d.endGroup ?? endProcessGroup)(pid)
    if (stopping && crashReason === null) return finish({ crashed: false, reason: `stopped (exit ${code ?? signal})` })
    const how = code !== null ? `code ${code}` : `signal ${signal}`
    finish({ crashed: true, reason: crashReason ?? (ready ? `it exited on its own (${how})` : `it exited before it was ready (${how})`) })
  })

  const rootUri = pathToUri(l.root, platform)
  client
    .request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Astera' },
        rootUri,
        rootPath: l.root,
        workspaceFolders: rootUri === null ? null : [{ uri: rootUri, name: path.basename(l.root) }],
        capabilities: clientCapabilities(l),
        ...(l.initializationOptions !== undefined ? { initializationOptions: l.initializationOptions } : {})
      },
      { timeoutMs: t.initializeMs }
    )
    .then(
      (res) => {
        if (finished || stopping) return
        const caps = (res as { capabilities?: { diagnosticProvider?: unknown } } | null)?.capabilities
        pulls = pulls || Boolean(caps?.diagnosticProvider)
        client.notify('initialized', {})
        ready = true
        d.onReady()
        for (const doc of docs.values()) sendOpen(doc)
      },
      (e: unknown) => {
        if (finished || stopping) return
        crashReason = `it did not answer initialize: ${e instanceof Error ? e.message : String(e)}`
        killTree()
      }
    )

  const exitedWithin = (ms: number): Promise<boolean> =>
    Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())])

  return {
    get pid() {
      return proc?.pid
    },
    open(p, text) {
      const k = key(p)
      const had = docs.get(k)
      const uri = pathToUri(p, platform)
      if (uri === null) return
      const doc: Doc = { path: p, uri, version: ++nextVersion, text }
      docs.set(k, doc)
      if (!ready || finished) return
      if (had) client.notify('textDocument/didClose', { textDocument: { uri: had.uri } })
      sendOpen(doc)
    },
    close(p) {
      const k = key(p)
      const had = docs.get(k)
      if (!had) return
      docs.delete(k)
      if (ready && !finished) client.notify('textDocument/didClose', { textDocument: { uri: had.uri } })
      d.onDiagnostics(had.path, [])
    },
    changed(p, kind) {
      if (!l.watchFiles || !ready || finished) return
      const uri = pathToUri(p, platform)
      if (uri === null) return
      client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: kind === 'created' ? 1 : kind === 'changed' ? 2 : 3 }] })
    },
    async shutdown() {
      if (finished) return
      stopping = true
      if (ready) {
        try {
          // No params member: TypeScript 7 refuses `"params": null`
          await client.request('shutdown', undefined, { timeoutMs: t.stopGraceMs })
        } catch {
          // it will be killed below if it does not go
        }
        client.notify('exit')
        proc?.stdin?.end()
      }
      if (pullTimer) clearTimeout(pullTimer)
      if (!(await exitedWithin(t.stopGraceMs))) {
        killTree()
        if (!(await exitedWithin(t.stopGraceMs))) finish({ crashed: false, reason: 'it was killed and its end was not seen' })
      }
    }
  }
}
