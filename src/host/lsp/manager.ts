// The Host's language servers (Phase 3 Part 3): one per (root, language), started when the app's first file of that
// language under that root opens, stopped 60 s after its last one closes, at most four at once (TypeScript 7 used 1.1 GB
// on this repository, measured 2026-11-26), and all of them when the Host leaves. The app sends its whole open set each
// time (`sync`), so a missed message or a reconnect cannot leave the two out of step; a saved or changed file is sent
// again only when its content changed, and a Python file changed on disk that is not open is told to pyright, which
// watches nothing itself (final review I3). A server that crashes restarts after the backoff with its files, and the
// third crash without 30 s of steady running since it became ready marks it failed (final review I1); a failed one starts
// again on `restart`, one stopped to make room when a file of it is saved (final review I4). An install, a removal or a
// settings change asks for a `refresh`: a server refused as not installed, a TypeScript root whose server choice changed,
// and a running server whose launch changed start again (final review C2). A TypeScript/JavaScript root is checked by
// the TypeScript 5 server when the project's own TypeScript is below 6 and that server is installed. Problems go to the
// app coalesced per tick; a stopped or crashed server's problems are cleared, and a file too large to send is said so.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase } from '../../core/files/paths'
import { isPathWithin } from '../../core/files/tree'
import { languageOf } from '../../core/lsp/languages'
import { projectTypescriptMajor } from '../../core/lsp/projectTypescript'
import { pythonPathFor, typescriptServerFor } from '../../core/lsp/servers'
import { languageServersOf } from '../../core/settings/languageServers'
import type { LanguageServerSettings, LspFileDiagnostics, LspLanguage, LspNote, LspOpenFile, LspProblem, LspServerId, LspServerStatus, LspWhy } from '../../core/lsp/model'
import { LSP_TIMINGS, lspLaunch, lspLogFile, startLspSession, type LspSession } from './session'

export interface LspManagerTimings {
  /** How long a server with no open file is kept. */
  idleMs: number
  /** The waits before the first, second and later restarts after a crash. */
  backoffMs: readonly number[]
  /** A run this long, counted from when the server became ready, resets the crash count. */
  stableMs: number
  /** The crash, counted from the last steady run, that marks the server failed. */
  failAfter: number
  /** The most servers running at once. */
  maxServers: number
}

export const LSP_MANAGER_TIMINGS: LspManagerTimings = { idleMs: 60_000, backoffMs: [1000, 2000], stableMs: 30_000, failAfter: 3, maxServers: 4 }

/** How long a leaving Host waits for its language servers: a stop's grace after `exit`, the kill's, and a second more. */
export const LSP_STOP_CAP_MS = LSP_TIMINGS.stopGraceMs * 2 + 1_000

/** A file larger than this is not sent to a server, and the project's package files larger than it are not read. */
export const LSP_FILE_MAX_BYTES = 2 * 1024 * 1024

/** TypeScript 7's tsconfig errors for options it removed (`baseUrl`, `moduleResolution: node`): the project seems to use
 *  an older TypeScript (measured on a TypeScript 5 project). */
const REMOVED_OPTION_CODES = new Set(['5102', '5108'])

/** Settings that could not be read: both languages off, as main's store reads them (final review M8). */
const SETTINGS_OFF = languageServersOf({ typescript: { enabled: false }, python: { enabled: false } })

/** What pyright reads from disk besides the open files: Python sources and its configuration. */
const pythonWatched = (p: string): boolean => {
  const name = path.basename(p).toLowerCase()
  return name === 'pyrightconfig.json' || name === 'pyproject.toml' || languageOf(p) === 'python'
}

interface Srv {
  key: string
  server: LspServerId
  language: LspLanguage
  root: string
  status: LspServerStatus['status']
  why?: LspWhy
  reason?: string
  notes: LspNote[]
  session: LspSession | null
  /** The open files it was given, by folded path, with their content's hash. */
  files: Map<string, { path: string; hash: string }>
  /** The files it reported problems for (open ones and others, as a tsconfig), by folded path. */
  emitted: Map<string, string>
  lastUsed: number
  idle: ReturnType<typeof setTimeout> | null
  restart: ReturnType<typeof setTimeout> | null
  crashes: number
  /** When the running session became ready; null while it is not. */
  readyAt: number | null
  /** What it was launched with (file and arguments), to see a changed path on refresh. */
  launchKey: string
  pythonPath?: string
}

export interface LspManager {
  sync(open: readonly LspOpenFile[], interpreters: Readonly<Record<string, string | null>>): void
  saved(paths: readonly string[], deleted?: readonly string[]): void
  appGone(): void
  /** After an install, a removal or a settings change: start again what that may have changed. */
  refresh(): void
  /** Starts a server for a root again, a failed one included. */
  restart(server: LspServerId, root: string): void
  /** Runs `fn` (a removal) once that server is stopped everywhere, before anything queued after it. */
  withServerStopped(id: LspServerId, fn: () => Promise<void>): Promise<void>
  status(): LspServerStatus[]
  logFile(server: LspServerId, root: string): string
  stopAll(): Promise<void>
  /** Resolves once everything asked so far is done. */
  settled(): Promise<void>
}

export function createLspManager(d: {
  profileDir: string
  exec: string
  env: NodeJS.ProcessEnv
  installer: { installed(id: LspServerId): Promise<boolean> }
  settings: () => Promise<LanguageServerSettings>
  emit(files: LspFileDiagnostics[]): void
  state(servers: LspServerStatus[]): void
  log(m: string): void
  start?: typeof startLspSession
  launch?: typeof lspLaunch
  readFile?: (p: string) => Promise<Buffer>
  stat?: (p: string) => Promise<{ size: number } | null>
  /** For tests: whether an interpreter is there (pythonPathFor's check). */
  exists?: (p: string) => boolean
  timings?: Partial<LspManagerTimings>
  now?: () => number
  platform?: string
}): LspManager {
  const t: LspManagerTimings = { ...LSP_MANAGER_TIMINGS, ...d.timings }
  const platform = d.platform ?? process.platform
  const now = d.now ?? Date.now
  const start = d.start ?? startLspSession
  const launch = d.launch ?? lspLaunch
  const readFile = d.readFile ?? ((p: string) => fs.readFile(p))
  const stat = d.stat ?? ((p: string) => fs.stat(p).then((s) => (s.isFile() ? { size: s.size } : null), () => null))
  const fold = (p: string): string => foldPathCase(p, platform)
  const within = (root: string, p: string): boolean => isPathWithin(root, p, platform)
  const servers = new Map<string, Srv>()
  let interpreters: Readonly<Record<string, string | null>> = {}
  let lastOpen: readonly LspOpenFile[] = []
  /** Open files too large to send, by folded path, with the server id their problems are keyed under. */
  const skipped = new Map<string, { path: string; root: string; server: LspServerId }>()
  let closed = false

  // Everything that changes the servers runs one after another
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(() => (closed ? undefined : fn())).catch((e: unknown) => d.log(`language servers: ${e instanceof Error ? e.message : String(e)}`))
    return chain
  }
  const settingsOf = (): Promise<LanguageServerSettings> =>
    d.settings().catch((e: unknown) => {
      d.log(`language servers: the settings could not be read, so both languages are off: ${e instanceof Error ? e.message : String(e)}`)
      return SETTINGS_OFF
    })

  // What the app hears, coalesced per tick
  let pendingProblems = new Map<string, LspFileDiagnostics>()
  let problemsQueued = false
  const emitRaw = (f: LspFileDiagnostics): void => {
    pendingProblems.set(`${f.server}|${fold(f.path)}`, f)
    if (problemsQueued) return
    problemsQueued = true
    queueMicrotask(() => {
      problemsQueued = false
      const out = [...pendingProblems.values()]
      pendingProblems = new Map()
      if (out.length > 0) d.emit(out)
    })
  }
  const emit = (srv: Srv, p: string, problems: LspProblem[]): void =>
    emitRaw({ root: srv.root, path: p, server: srv.server, producedAt: new Date(now()).toISOString(), problems })
  let stateQueued = false
  const stateChanged = (): void => {
    if (stateQueued) return
    stateQueued = true
    queueMicrotask(() => {
      stateQueued = false
      d.state(status())
    })
  }

  const status = (): LspServerStatus[] =>
    [...servers.values()].map((s) => ({
      server: s.server,
      root: s.root,
      status: s.status,
      ...(s.why !== undefined ? { why: s.why } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      ...(s.session?.pid !== undefined ? { pid: s.session.pid } : {}),
      ...(s.notes.length > 0 ? { notes: [...s.notes] } : {})
    }))

  /** A file's text, or null when it is gone, not a file, or unreadable; `tooLarge` past the bound. */
  const readBounded = async (p: string): Promise<{ text: string } | { tooLarge: true } | null> => {
    const st = await stat(p)
    if (st === null) return null
    if (st.size > LSP_FILE_MAX_BYTES) return { tooLarge: true }
    try {
      return { text: (await readFile(p)).toString('utf8') }
    } catch {
      return null
    }
  }
  const readSmall = async (p: string): Promise<string | null> => {
    const r = await readBounded(p)
    return r !== null && 'text' in r ? r.text : null
  }
  const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')
  const interpreterFor = (root: string): string | null => Object.entries(interpreters).find(([r]) => fold(r) === fold(root))?.[1] ?? null
  const keyOf = (language: LspLanguage, root: string): string => `${language}|${fold(root)}`

  const clearEmitted = (srv: Srv): void => {
    for (const p of srv.emitted.values()) emit(srv, p, [])
    srv.emitted.clear()
  }

  const onProblems = (srv: Srv, session: LspSession, p: string, problems: LspProblem[]): void => {
    if (srv.session !== session) return
    if (problems.length > 0) srv.emitted.set(fold(p), p)
    else srv.emitted.delete(fold(p))
    emit(srv, p, problems)
    if (srv.server === 'typescript' && !srv.notes.includes('older-typescript') && problems.some((x) => x.code !== undefined && REMOVED_OPTION_CODES.has(x.code))) {
      srv.notes.push('older-typescript')
      stateChanged()
    }
  }

  const onExit = (srv: Srv, session: LspSession, why: { crashed: boolean; reason: string }): void => {
    if (srv.session !== session) return
    srv.session = null
    clearEmitted(srv)
    const ran = srv.readyAt === null ? 0 : now() - srv.readyAt
    srv.readyAt = null
    if (!why.crashed) {
      srv.status = 'stopped'
      stateChanged()
      return
    }
    d.log(`the ${srv.server} server for ${srv.root} crashed: ${why.reason}`)
    // A run that never became ready ran nothing, however long it waited (final review I1)
    if (ran >= t.stableMs) srv.crashes = 0
    srv.crashes++
    srv.reason = why.reason
    if (srv.crashes >= t.failAfter) {
      srv.status = 'failed'
      srv.why = 'crashed'
      stateChanged()
      return
    }
    srv.status = 'starting'
    stateChanged()
    const wait = t.backoffMs[Math.min(srv.crashes - 1, t.backoffMs.length - 1)] ?? 1000
    srv.restart = setTimeout(() => {
      srv.restart = null
      void enqueue(async () => {
        if (servers.get(srv.key) !== srv || srv.files.size === 0 || srv.session !== null || srv.status !== 'starting') return
        // The cap holds through a restart too (final review M1)
        await makeRoom(srv)
        await startSession(srv, await settingsOf())
      })
    }, wait)
  }

  const startSession = async (srv: Srv, settings: LanguageServerSettings): Promise<void> => {
    if (closed) return
    const python = srv.language === 'python' ? pythonPathFor(interpreterFor(srv.root), d.profileDir, d.exists) : undefined
    srv.pythonPath = python?.pythonPath
    const l = launch({ server: srv.server, root: srv.root, profileDir: d.profileDir, exec: d.exec, env: d.env, settings, ...(python ? { pythonPath: python } : {}), platform })
    if ('refused' in l) {
      srv.status = 'stopped'
      srv.why = l.why
      srv.reason = l.refused
      stateChanged()
      return
    }
    srv.status = 'starting'
    srv.why = undefined
    srv.readyAt = null
    srv.launchKey = [l.file, ...l.args].join('\0')
    const session: LspSession = start(l, {
      onDiagnostics: (p, problems) => onProblems(srv, session, p, problems),
      onReady: () => {
        if (srv.session !== session) return
        srv.status = 'running'
        srv.reason = undefined
        srv.readyAt = now()
        stateChanged()
      },
      onTrouble: (reason) => {
        if (srv.session !== session) return
        srv.reason = reason
        stateChanged()
      },
      onExit: (why) => onExit(srv, session, why)
    })
    srv.session = session
    stateChanged()
    for (const [k, f] of [...srv.files]) {
      const text = await readSmall(f.path)
      if (srv.session !== session) return
      if (text === null) {
        srv.files.delete(k)
        continue
      }
      f.hash = hashOf(text)
      session.open(f.path, text)
    }
  }

  const stopSrv = async (srv: Srv, o: { why?: LspWhy; remove?: boolean } = {}): Promise<void> => {
    if (srv.idle) clearTimeout(srv.idle)
    if (srv.restart) clearTimeout(srv.restart)
    srv.idle = null
    srv.restart = null
    const s = srv.session
    srv.status = 'stopped'
    srv.why = o.why
    srv.reason = o.why === 'room' ? 'stopped to make room for another server' : undefined
    if (s) await s.shutdown()
    else clearEmitted(srv)
    if (o.remove && servers.get(srv.key) === srv) servers.delete(srv.key)
    stateChanged()
  }

  /** Stops the least recently used running servers until one more fits (`except` is the one about to start). */
  const makeRoom = async (except?: Srv): Promise<void> => {
    for (;;) {
      const live = [...servers.values()].filter((s) => s.session !== null && s !== except)
      if (live.length < t.maxServers) return
      let victim = live[0]
      for (const s of live) if (s.lastUsed < victim.lastUsed) victim = s
      d.log(`stopping the ${victim.server} server for ${victim.root} to make room (at most ${t.maxServers} run at once)`)
      await stopSrv(victim, { why: 'room' })
    }
  }

  const typescriptChoice = async (root: string): Promise<{ server: LspServerId; notes: LspNote[] }> => {
    const installed = new Set<LspServerId>()
    if (await d.installer.installed('typescript5')) installed.add('typescript5')
    // The project's package files are read within the same bound as a document (final review M10)
    return typescriptServerFor(await projectTypescriptMajor(root, readSmall), installed)
  }

  const create = async (language: LspLanguage, root: string, settings: LanguageServerSettings): Promise<Srv | null> => {
    if (closed) return null
    const { server, notes } = language === 'typescript' ? await typescriptChoice(root) : { server: 'python' as LspServerId, notes: [] as LspNote[] }
    await makeRoom()
    if (closed) return null
    const srv: Srv = {
      key: keyOf(language, root),
      server,
      language,
      root,
      status: 'starting',
      notes,
      session: null,
      files: new Map(),
      emitted: new Map(),
      lastUsed: now(),
      idle: null,
      restart: null,
      crashes: 0,
      readyAt: null,
      launchKey: ''
    }
    servers.set(srv.key, srv)
    await startSession(srv, settings)
    return srv
  }

  const scheduleIdle = (srv: Srv): void => {
    if (srv.files.size > 0) return
    if (srv.session === null) {
      if (srv.restart) clearTimeout(srv.restart)
      servers.delete(srv.key)
      stateChanged()
      return
    }
    if (srv.idle) return
    srv.idle = setTimeout(() => {
      srv.idle = null
      void enqueue(async () => {
        if (srv.files.size === 0 && servers.get(srv.key) === srv) await stopSrv(srv, { remove: true })
      })
    }, t.idleMs)
  }

  const closeFile = (srv: Srv, k: string): void => {
    const f = srv.files.get(k)
    if (!f) return
    srv.files.delete(k)
    if (srv.session) srv.session.close(f.path)
    else if (srv.emitted.has(k)) {
      srv.emitted.delete(k)
      emit(srv, f.path, [])
    }
    scheduleIdle(srv)
  }

  const unskip = (k: string): void => {
    const s = skipped.get(k)
    if (!s) return
    skipped.delete(k)
    emitRaw({ root: s.root, path: s.path, server: s.server, producedAt: new Date(now()).toISOString(), problems: [] })
  }

  const apply = async (open: readonly LspOpenFile[]): Promise<void> => {
    lastOpen = open
    const settings = await settingsOf()
    const desired = new Map<string, { path: string; root: string; language: LspLanguage }>()
    for (const f of open) {
      const language = languageOf(f.path)
      if (language === null || !settings[language].enabled || !within(f.root, f.path)) continue
      desired.set(fold(f.path), { path: f.path, root: f.root, language })
    }
    for (const srv of [...servers.values()]) {
      for (const k of [...srv.files.keys()]) {
        const want = desired.get(k)
        if (!want || keyOf(want.language, want.root) !== srv.key) closeFile(srv, k)
      }
    }
    for (const k of [...skipped.keys()]) if (!desired.has(k)) unskip(k)
    // A python server whose interpreter changed starts again with it
    for (const srv of [...servers.values()]) {
      if (srv.language !== 'python' || srv.session === null || srv.files.size === 0) continue
      if (pythonPathFor(interpreterFor(srv.root), d.profileDir, d.exists).pythonPath === srv.pythonPath) continue
      await stopSrv(srv)
      srv.crashes = 0
      await startSession(srv, settings)
    }
    for (const [k, want] of desired) {
      let srv = servers.get(keyOf(want.language, want.root))
      if (srv?.files.has(k)) continue
      const read = await readBounded(want.path)
      if (read === null) continue
      if ('tooLarge' in read) {
        if (!skipped.has(k)) {
          const server: LspServerId = srv?.server ?? (want.language === 'python' ? 'python' : 'typescript')
          skipped.set(k, { path: want.path, root: want.root, server })
          emitRaw({ root: want.root, path: want.path, server, producedAt: new Date(now()).toISOString(), problems: [], skipped: 'too-large' })
        }
        continue
      }
      unskip(k)
      srv ??= (await create(want.language, want.root, settings)) ?? undefined
      if (!srv) return
      if (srv.idle) clearTimeout(srv.idle)
      srv.idle = null
      srv.files.set(k, { path: want.path, hash: hashOf(read.text) })
      srv.lastUsed = now()
      srv.session?.open(want.path, read.text)
    }
    stateChanged()
  }

  return {
    sync(open, given) {
      void enqueue(async () => {
        interpreters = given
        await apply(open)
      })
    },
    saved(paths, deleted = []) {
      void enqueue(async () => {
        let reapply = false
        const settings = await settingsOf()
        const one = async (p: string, gone: boolean): Promise<void> => {
          const k = fold(p)
          let open = false
          for (const srv of [...servers.values()]) {
            const f = srv.files.get(k)
            if (!f) continue
            open = true
            // Saving a file of a root stopped to make room starts it again: the person works there (final review I4)
            if (!gone && srv.session === null && srv.status === 'stopped' && srv.why === 'room') {
              srv.lastUsed = now()
              await makeRoom(srv)
              await startSession(srv, settings)
              continue
            }
            const text = gone ? null : await readSmall(f.path)
            if (text === null) {
              closeFile(srv, k)
              continue
            }
            const hash = hashOf(text)
            if (hash === f.hash) continue
            f.hash = hash
            srv.lastUsed = now()
            srv.session?.open(f.path, text)
          }
          if (open) return
          if (skipped.has(k)) reapply = true
          // A Python file it has not open: pyright is told, since it watches nothing itself (final review I3)
          if (!pythonWatched(p)) return
          for (const srv of servers.values()) if (srv.language === 'python' && srv.session !== null && within(srv.root, p)) srv.session.changed(p, gone ? 'deleted' : 'changed')
        }
        for (const p of paths) await one(p, false)
        for (const p of deleted) await one(p, true)
        if (reapply) await apply(lastOpen)
      })
    },
    appGone() {
      void enqueue(async () => {
        interpreters = {}
        await apply([])
      })
    },
    refresh() {
      void enqueue(async () => {
        const settings = await settingsOf()
        for (const srv of [...servers.values()]) {
          // Refused before (not installed, a path not there): forgotten, so the open set starts it afresh
          if (srv.session === null && (srv.why === 'not-installed' || srv.why === 'refused')) {
            servers.delete(srv.key)
            clearEmitted(srv)
            continue
          }
          if (srv.language === 'typescript' && (await typescriptChoice(srv.root)).server !== srv.server) {
            await stopSrv(srv, { remove: true })
            continue
          }
          // A failed one is compared too: a person who changed what it runs (a path fixed in Settings) expects it to try again
          if (srv.session === null && srv.status !== 'failed') continue
          const python = srv.language === 'python' ? pythonPathFor(interpreterFor(srv.root), d.profileDir, d.exists) : undefined
          const l = launch({ server: srv.server, root: srv.root, profileDir: d.profileDir, exec: d.exec, env: d.env, settings, ...(python ? { pythonPath: python } : {}), platform })
          if ('refused' in l || [l.file, ...l.args].join('\0') !== srv.launchKey) await stopSrv(srv, { remove: true })
        }
        stateChanged()
        await apply(lastOpen)
      })
    },
    restart(server, root) {
      void enqueue(async () => {
        const srv = [...servers.values()].find((s) => s.server === server && fold(s.root) === fold(root))
        if (srv) await stopSrv(srv, { remove: true })
        await apply(lastOpen)
      })
    },
    withServerStopped(id, fn) {
      return new Promise<void>((resolve, reject) => {
        void enqueue(async () => {
          try {
            for (const srv of [...servers.values()]) if (srv.server === id) await stopSrv(srv, { remove: true })
            await fn()
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
    },
    status,
    logFile: (server, root) => lspLogFile(d.profileDir, server, root, platform),
    async stopAll() {
      closed = true
      // What was already running finishes, starting nothing more (final review M2), then everything stops
      await chain
      await Promise.all([...servers.values()].map((srv) => stopSrv(srv, { remove: true })))
    },
    settled: () => chain
  }
}
