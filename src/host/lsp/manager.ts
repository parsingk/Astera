// The Host's language servers (Phase 3 Part 3): one per (root, language), started when the app's first file of that
// language under that root opens, stopped 60 s after its last one closes, at most four at once (TypeScript 7 used 1.1 GB
// on this repository, measured 2026-11-26), and all of them when the Host leaves. The app sends its whole open set each
// time (`sync`), so a missed message or a reconnect cannot leave the two out of step; a saved or changed file is sent
// again only when its content changed. A server that crashes restarts after the backoff with its files, and the third
// crash without 30 s of steady running marks it failed until its files close. A TypeScript/JavaScript root is checked by
// the TypeScript 5 server when the project's own TypeScript is below 6 and that server is installed. Problems go to the
// app coalesced per tick; a stopped or crashed server's problems are cleared.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isUnder } from '../../core/context/contextRef'
import { foldPathCase } from '../../core/files/paths'
import { languageOf } from '../../core/lsp/languages'
import { projectTypescriptMajor } from '../../core/lsp/projectTypescript'
import { pythonPathFor, typescriptServerFor } from '../../core/lsp/servers'
import type { LanguageServerSettings, LspFileDiagnostics, LspLanguage, LspNote, LspOpenFile, LspProblem, LspServerId, LspServerStatus, LspWhy } from '../../core/lsp/model'
import { LSP_TIMINGS, lspLaunch, lspLogFile, startLspSession, type LspSession } from './session'

export interface LspManagerTimings {
  /** How long a server with no open file is kept. */
  idleMs: number
  /** The waits before the first, second and later restarts after a crash. */
  backoffMs: readonly number[]
  /** A run this long resets the crash count. */
  stableMs: number
  /** The crash, counted from the last steady run, that marks the server failed. */
  failAfter: number
  /** The most servers running at once. */
  maxServers: number
}

export const LSP_MANAGER_TIMINGS: LspManagerTimings = { idleMs: 60_000, backoffMs: [1000, 2000], stableMs: 30_000, failAfter: 3, maxServers: 4 }

/** How long a leaving Host waits for its language servers: a stop's grace after `exit`, the kill's, and a second more. */
export const LSP_STOP_CAP_MS = LSP_TIMINGS.stopGraceMs * 2 + 1_000

/** A file larger than this is not sent to a server. */
export const LSP_FILE_MAX_BYTES = 2 * 1024 * 1024

/** TypeScript 7's tsconfig errors for options it removed (`baseUrl`, `moduleResolution: node`): the project seems to use
 *  an older TypeScript (measured on a TypeScript 5 project). */
const REMOVED_OPTION_CODES = new Set(['5102', '5108'])

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
  startedAt: number
  pythonPath?: string
}

export interface LspManager {
  sync(open: readonly LspOpenFile[], interpreters: Readonly<Record<string, string | null>>): void
  saved(paths: readonly string[]): void
  appGone(): void
  status(): LspServerStatus[]
  logFile(server: LspServerId, root: string): string
  stopServer(id: LspServerId): Promise<void>
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
  const servers = new Map<string, Srv>()
  let interpreters: Readonly<Record<string, string | null>> = {}
  let closed = false

  // Everything that changes the servers runs one after another
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>): void => {
    chain = chain.then(() => (closed ? undefined : fn())).catch((e: unknown) => d.log(`language servers: ${e instanceof Error ? e.message : String(e)}`))
  }

  // What the app hears, coalesced per tick
  let pendingProblems = new Map<string, LspFileDiagnostics>()
  let problemsQueued = false
  const emit = (srv: Srv, p: string, problems: LspProblem[]): void => {
    pendingProblems.set(`${srv.server}|${fold(p)}`, { root: srv.root, path: p, server: srv.server, producedAt: new Date(now()).toISOString(), problems })
    if (problemsQueued) return
    problemsQueued = true
    queueMicrotask(() => {
      problemsQueued = false
      const out = [...pendingProblems.values()]
      pendingProblems = new Map()
      if (out.length > 0) d.emit(out)
    })
  }
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

  const readSmall = async (p: string): Promise<string | null> => {
    const st = await stat(p)
    if (st === null || st.size > LSP_FILE_MAX_BYTES) return null
    try {
      return (await readFile(p)).toString('utf8')
    } catch {
      return null
    }
  }
  const readText = async (p: string): Promise<string | null> => {
    try {
      return (await readFile(p)).toString('utf8')
    } catch {
      return null
    }
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
    if (!why.crashed) {
      srv.status = 'stopped'
      stateChanged()
      return
    }
    d.log(`the ${srv.server} server for ${srv.root} crashed: ${why.reason}`)
    if (now() - srv.startedAt >= t.stableMs) srv.crashes = 0
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
      enqueue(async () => {
        if (servers.get(srv.key) === srv && srv.files.size > 0 && srv.session === null && srv.status === 'starting') await startSession(srv, await d.settings())
      })
    }, wait)
  }

  const startSession = async (srv: Srv, settings: LanguageServerSettings): Promise<void> => {
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
    srv.startedAt = now()
    const session: LspSession = start(l, {
      onDiagnostics: (p, problems) => onProblems(srv, session, p, problems),
      onReady: () => {
        if (srv.session !== session) return
        srv.status = 'running'
        srv.reason = undefined
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
    if (o.remove && servers.get(srv.key) === srv) servers.delete(srv.key)
    stateChanged()
  }

  const makeRoom = async (): Promise<void> => {
    for (;;) {
      const live = [...servers.values()].filter((s) => s.session !== null)
      if (live.length < t.maxServers) return
      let victim = live[0]
      for (const s of live) if (s.lastUsed < victim.lastUsed) victim = s
      d.log(`stopping the ${victim.server} server for ${victim.root} to make room (at most ${t.maxServers} run at once)`)
      await stopSrv(victim, { why: 'room' })
    }
  }

  const create = async (language: LspLanguage, root: string, settings: LanguageServerSettings): Promise<Srv> => {
    let server: LspServerId = 'python'
    let notes: LspNote[] = []
    if (language === 'typescript') {
      const installed = new Set<LspServerId>()
      if (await d.installer.installed('typescript5')) installed.add('typescript5')
      ;({ server, notes } = typescriptServerFor(await projectTypescriptMajor(root, readText), installed))
    }
    await makeRoom()
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
      startedAt: now()
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
      enqueue(async () => {
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

  const apply = async (open: readonly LspOpenFile[]): Promise<void> => {
    const settings = await d.settings()
    const desired = new Map<string, { path: string; root: string; language: LspLanguage }>()
    for (const f of open) {
      const language = languageOf(f.path)
      if (language === null || !settings[language].enabled || !isUnder(f.root, f.path)) continue
      desired.set(fold(f.path), { path: f.path, root: f.root, language })
    }
    for (const srv of [...servers.values()]) {
      for (const k of [...srv.files.keys()]) {
        const want = desired.get(k)
        if (!want || keyOf(want.language, want.root) !== srv.key) closeFile(srv, k)
      }
    }
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
      const text = await readSmall(want.path)
      if (text === null) continue
      srv ??= await create(want.language, want.root, settings)
      if (srv.idle) clearTimeout(srv.idle)
      srv.idle = null
      srv.files.set(k, { path: want.path, hash: hashOf(text) })
      srv.lastUsed = now()
      srv.session?.open(want.path, text)
    }
    stateChanged()
  }

  return {
    sync(open, given) {
      enqueue(async () => {
        interpreters = given
        await apply(open)
      })
    },
    saved(paths) {
      enqueue(async () => {
        for (const p of paths) {
          const k = fold(p)
          for (const srv of servers.values()) {
            const f = srv.files.get(k)
            if (!f) continue
            const text = await readSmall(f.path)
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
        }
      })
    },
    appGone() {
      enqueue(async () => {
        interpreters = {}
        await apply([])
      })
    },
    status,
    logFile: (server, root) => lspLogFile(d.profileDir, server, root, platform),
    async stopServer(id) {
      enqueue(async () => {
        for (const srv of [...servers.values()]) if (srv.server === id) await stopSrv(srv, { remove: true })
      })
      await chain
    },
    async stopAll() {
      closed = true
      await Promise.all([...servers.values()].map((srv) => stopSrv(srv, { remove: true })))
    },
    settled: () => chain
  }
}
