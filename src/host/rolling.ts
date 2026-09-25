// The Host's rolling (S6 design §2, §3; plan R1, R10, R12, R20–R24): the two coordinators the app runs,
// built over this Host's registry, statusline reader, hook events, accounts and state. The Host's own
// sessions are registered at spawn (adoptSpawned); an app's are restored at takeover (restore).
//
// Imports only core modules, node builtins and the Host's own modules: this bundles into the Host.
import path from 'node:path'
import { RollingCoordinator } from '../core/rolling/claudeCoordinator'
import { CodexRollingCoordinator } from '../core/rolling/codexCoordinator'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import { RollConfigStore, hostRollConfigPath } from '../core/rolling/config'
import { HookEventWatcher } from '../core/hooks/eventWatcher'
import { hookEventsDirIn } from '../core/hooks/sessionState'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { isLoggedIn as isLoggedInWith } from '../core/accounts/loginCheck'
import { memoiseLoginStatus } from '../core/accounts/loginStatusCache'
import { makeDescriptors } from '../core/providers/descriptor'
import { providerOf } from '../core/providers/meta'
import { readResumeStrategy } from '../core/settings/resumeStrategy'
import { RateLimitFetcher, USAGE_GATE_MAX_AGE_MS } from '../core/usage/rateLimitFetcher'
import type { RollSnapshot, RollSpawnExtra } from '../core/rolling/snapshot'
import type { Lang } from '../core/i18n'
import type { Account, RateLimitPeak, ResumeStrategy, RollStateEvent, SessionInfo } from '../core/types'
import type { PtyRegistry } from './registry'
import { hostRollingLog } from './rollingLog'

export type HostRollEvent =
  | { t: 'roll-state'; event: RollStateEvent }
  | { t: 'session-rolled'; oldSessionId: string; info: SessionInfo; dest?: string }

/** What a roll's respawn is given (the spawner implements it in Task 10). */
export interface RollSpawnOpts {
  account: Account
  cwd: string
  resumeSessionId?: string
  resumePrompt?: string
  initialPrompt?: string
  rollAccountIds?: string[]
  rollPrompt?: string
  slackNotify?: boolean
  bypassPermissions?: boolean
  title?: string
  /** The coordinators' closed shape (Task 7), with `rolledBy: 'host'` always set here (R6). */
  restoreExtra?: RollSpawnExtra
}

/** The three spawner members rolling needs; `HostSpawner` implements them (Task 10). */
export interface HostRollSpawner {
  prepareRollSpawn(account: Account, cwd: string): Promise<void>
  rollSpawn(opts: RollSpawnOpts): SessionInfo
  statusLinePayload(sessionId: string): Promise<unknown | null>
}

export interface HostRollingDeps {
  profileDir: string
  platform: NodeJS.Platform
  registry: Pick<PtyRegistry, 'onData' | 'onExit' | 'metaOf' | 'sessionPty' | 'write' | 'kill' | 'list'>
  spawner: HostRollSpawner
  /** R1 for the pty this session runs in (the wiring asks hostMayAct over exits and server). */
  mayAct(ptyId: string): boolean
  /** The Host's roll tap (Task 11). */
  tap: { onRolled(oldSessionId: string, info: { id: string; accountId: string }): Promise<void>; onRollState(e: RollStateEvent): void }
  /** R22: the Job packet or note over the Host's state; null for a session with no open Dispatch. */
  resumeText(sessionId: string, form: 'handover' | 'update'): Promise<string | null>
  onNativeSession(sessionId: string, nativeSessionId: string): void
  /** What an attached app is told (Task 13 broadcasts it). */
  onEvent(e: HostRollEvent): void
  lang(): Lang
  /** Test seams. */
  readAccounts?(): Promise<Account[]>
  readStrategy?(): Promise<ResumeStrategy>
  isLoggedIn?(account: Account): Promise<boolean>
  /** R28 (preflight R1): the account usage lookup. Default: a RateLimitFetcher on the global fetch,
   *  read as index.ts reads it (USAGE_GATE_MAX_AGE_MS, then the peak when status is ok). */
  fetchUsage?(configDir: string): Promise<RateLimitPeak | null>
  copy?(src: string, dest: string): Promise<void>
  log?(m: string): void
  logCodex?(m: string): void
  watchHooks?: boolean
}

export interface HostRolling {
  /** A session this Host just spawned (spawner.onSpawned, Task 10). */
  adoptSpawned(info: SessionInfo, account: Account): void
  /** A snapshotted session taken over (Task 12). */
  restore(info: SessionInfo, snap: RollSnapshot): boolean
  has(sessionId: string): boolean
  unregister(sessionId: string): void
  stateOf(sessionId: string): RollStateEvent | null
  forceRoll(sessionId: string): Promise<void>
  /** The accounts snapshot and the resume strategy, read again (the tick, and at start). */
  refresh(): Promise<void>
  onHookEvent(sessionId: string, payload: unknown): void
  dispose(): void
}

export function createHostRolling(d: HostRollingDeps): HostRolling {
  const log = d.log ?? hostRollingLog(d.profileDir, '[host]')
  const logCodex = d.logCodex ?? hostRollingLog(d.profileDir, '[host][codex]')
  let accounts: Account[] = []
  let accountsRead = false
  let strategy: ResumeStrategy = 'original'
  const readAccounts = d.readAccounts ?? (() => readAccountEntries(path.join(d.profileDir, 'accounts.json')))
  const readStrategy = d.readStrategy ?? (() => readResumeStrategy(path.join(d.profileDir, 'app-settings.json')))
  // The real probes are built only when no seam replaces them, so a test that injects both reads nothing
  // of this machine's accounts, keychain or network.
  let descriptors: ReturnType<typeof makeDescriptors> | null = null
  const loggedIn =
    d.isLoggedIn ?? ((a: Account) => isLoggedInWith(a, (descriptors ??= makeDescriptors(d.platform))))
  const loginStatus = memoiseLoginStatus(
    async (id: string) => {
      const a = accounts.find((x) => x.id === id)
      return a ? loggedIn(a) : false
    },
    { ttlMs: 10_000 }
  )
  // R28 (preflight R1): the Host asks the account itself, as the app does; Q4 accepts when it fails.
  let usage: RateLimitFetcher | null = null
  const fetchUsage =
    d.fetchUsage ??
    (async (configDir: string): Promise<RateLimitPeak | null> => {
      const u = await (usage ??= new RateLimitFetcher()).get(configDir, USAGE_GATE_MAX_AGE_MS)
      return u.status === 'ok' ? u.peak : null
    })
  /** R29 (preflight R3): a dependency the coordinators call as `void this.x()` must never reject, or the
   *  Host (no unhandledRejection handler) ends with every pty. Each answers its "nothing known" value.
   *  **Two are left rejecting on purpose**: `prepareSpawn` and `copy` are awaited only inside roll()'s own
   *  try, whose catch reschedules — a copy that could not reject would let a roll kill and respawn onto a
   *  transcript that was never copied. */
  const safe =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>, fallback: R) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a)
      } catch (err) {
        log(`${name} failed: ${String(err)}`)
        return fallback
      }
    }
  const configs = new RollConfigStore(hostRollConfigPath(d.profileDir))
  const configsLoaded = configs.load().catch(() => ({ recovered: true }))
  const blocks = new BlockRegistry()
  const ptyOf = (sessionId: string): string | null => d.registry.sessionPty(sessionId)
  const write = (id: string, data: string): void => {
    const p = ptyOf(id)
    if (!p) return
    try {
      d.registry.write(p, data)
    } catch (err) {
      log(`write refused session=${id}: ${String(err)}`)
    }
  }
  const kill = (id: string): void => {
    const p = ptyOf(id)
    if (p) d.registry.kill(p)
  }
  /** A session with no live pty here is not this Host's to act on. */
  const mayAct = (id: string): boolean => {
    const p = ptyOf(id)
    return p !== null && d.mayAct(p)
  }
  /** The fan-out of a coordinator's send (§1.6): the tap, then the apps. Each isolated (constraint 11). */
  const send = (channel: 'session:rolled' | 'session:rollState', payload: unknown): void => {
    try {
      if (channel === 'session:rolled') {
        const p = payload as { oldSessionId: string; info: SessionInfo; dest?: string }
        void d.tap.onRolled(p.oldSessionId, { id: p.info.id, accountId: p.info.accountId }).catch((err) => log(`roll tap failed: ${String(err)}`))
        d.onEvent({ t: 'session-rolled', oldSessionId: p.oldSessionId, info: p.info, ...(p.dest !== undefined ? { dest: p.dest } : {}) })
      } else {
        d.tap.onRollState(payload as RollStateEvent)
        d.onEvent({ t: 'roll-state', event: payload as RollStateEvent })
      }
    } catch (err) {
      log(`a roll event could not be delivered: ${String(err)}`)
    }
  }
  /** The respawn is this Host's spawn, marked as its own (R6). */
  const rollSpawn = (o: RollSpawnOpts): SessionInfo =>
    d.spawner.rollSpawn({ ...o, ...(o.restoreExtra ? { restoreExtra: { ...o.restoreExtra, rolledBy: 'host' } } : {}) })
  const common = {
    // Its async half is done first, while the old session lives (R5). Left rejecting (see `safe`).
    prepareSpawn: (account: Account, cwd: string) => d.spawner.prepareRollSpawn(account, cwd),
    write,
    kill,
    getAccount: (id: string) => accounts.find((a) => a.id === id) ?? null,
    loginStatus: safe('login status', loginStatus, true),
    send,
    lang: d.lang,
    blocks,
    persistConfig: (key: string, cfg: { accountIds: string[]; prompt?: string }) => {
      void configsLoaded.then(() => configs.set(key, cfg)).catch((err) => log(`roll config write failed: ${String(err)}`))
    },
    // Called inside the coordinators' own flow (applyMeta, a rekey), so a throw would cut that flow short.
    onNativeSession: (sessionId: string, nativeSessionId: string) => {
      try {
        d.onNativeSession(sessionId, nativeSessionId)
      } catch (err) {
        log(`native session report failed session=${sessionId}: ${String(err)}`)
      }
    },
    // R22: the Job packet or note; a tab or a coordinator gets its own chain.prompt. The coordinators'
    // third argument (the tab fallback) has nothing to fall back to here: the Host has no tab briefing.
    resumeText: safe('resume text', (sessionId: string, form: 'handover' | 'update') => d.resumeText(sessionId, form), null),
    resumeStrategy: () => strategy,
    mayAct,
    ...(d.copy ? { copy: d.copy } : {})
  }
  const claude = new RollingCoordinator({
    ...common,
    spawn: rollSpawn,
    readStatusPayload: safe('statusline read', (id: string) => d.spawner.statusLinePayload(id), null),
    readUsage: safe('usage lookup', fetchUsage, null),
    log
  })
  const codex = new CodexRollingCoordinator({
    ...common,
    spawn: rollSpawn,
    log: logCodex
  })

  // R20: session ptys only, by the session id in the note.
  d.registry.onData((ptyId, data) => {
    const m = d.registry.metaOf(ptyId)
    if (m?.kind !== 'session') return
    try {
      claude.handleData({ sessionId: m.id, data })
      codex.handleData({ sessionId: m.id, data })
    } catch (err) {
      log(`rolling could not read output session=${m.id}: ${String(err)}`)
    }
  })
  d.registry.onExit((ptyId) => {
    const m = d.registry.metaOf(ptyId)
    if (m?.kind !== 'session') return
    // A session still live in another pty did not end: a respawn that keeps the session id opens the new
    // pty before the old one's exit lands (registry.sessionPty's own note), and that exit is not its end.
    if (d.registry.sessionPty(m.id) !== null) return
    try {
      claude.handleExit({ sessionId: m.id })
      codex.handleExit({ sessionId: m.id })
    } catch (err) {
      log(`rolling could not take an exit session=${m.id}: ${String(err)}`)
    }
  })
  const hooks =
    d.watchHooks === false
      ? null
      : new HookEventWatcher(hookEventsDirIn(d.profileDir), (sid, p) => claude.onHookEvent(sid, p), log, undefined, { startAtEnd: true })
  hooks?.start()

  return {
    adoptSpawned: (info, account) => {
      if ((info.rollAccountIds?.length ?? 0) < 1) return
      // R12: a codex chain is attached by the spawner's own locate (attachFresh), never by a second scan.
      if (providerOf(account) === 'codex') codex.register(info, undefined, false, false)
      else claude.register(info)
    },
    restore: (info, snap) => (snap.provider === 'codex' ? codex.restore(info, snap) : claude.restore(info, snap)),
    has: (id) => claude.has(id) || codex.has(id),
    unregister: (id) => {
      claude.unregister(id)
      codex.unregister(id)
    },
    stateOf: (id) => claude.stateOf(id) ?? codex.stateOf(id),
    forceRoll: (id) => (codex.has(id) ? codex.forceRoll(id) : claude.forceRoll(id)),
    refresh: async () => {
      try {
        accounts = await readAccounts()
        accountsRead = true
      } catch (err) {
        // R23: the last good snapshot stands; never read means no account resolves.
        log(`accounts.json could not be read${accountsRead ? ' — the last good read stands' : ''}: ${String(err)}`)
      }
      strategy = await readStrategy().catch(() => 'original' as const)
    },
    onHookEvent: (sid, p) => claude.onHookEvent(sid, p),
    dispose: () => {
      hooks?.stop()
      claude.stop()
      codex.stop()
    }
  }
}
