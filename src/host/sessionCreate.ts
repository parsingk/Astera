// `sessions create` (CLI spec §14): the Host starts an agent session for a person or a script, with
// Astera open or closed.
//
// **No new spawn path.** A terminal session goes through the Host spawner's `createSession`, which is
// the spawn its workers and coordinators take (`spawnSession`: the account, the folder trusted, the
// statusLine and hooks, the D4 environment, and the bypass read from app-settings.json at each spawn).
// A chat session goes through the Host's chat manager (`HostChats.spawn`), which is the spawn its rolls
// take: `hostStarting` is set until the handshake settles, so no app adopts it half started, and
// `rolledBy: 'host'` says the Host rolls its chain.
//
// **What a running app sees.** A terminal session's pty is announced by the spawner itself
// (`pty-opened`), and the app takes it back as a tab. A chat session's proc is announced here once its
// start has settled (`proc-opened`), to the apps that yield chat takeover, which take it back the way
// they take a rolled chat proc. An older app ignores the message and adopts the session at its next
// sweep.
//
// Imports only core modules and the Host's own: this bundles into the Host.
import type { HostSession, SessionCreate } from '../core/orchestration/command'
import { refusedBeforeActing } from '../core/host/orchProtocol'
import type { Account, SessionInfo } from '../core/types'
import type { HostChats } from './hostChats'
import type { HostRolling } from './rolling'
import type { HostSpawner } from './spawner'

export function createHostSessionStarter(d: {
  /** Null for a Host started without the agent CLI paths: it starts no session. */
  spawner: Pick<HostSpawner, 'createSession'> | null
  /** Null when the Host has no chat manager (no spawner, so no rolling wiring). */
  chats: Pick<HostChats, 'spawn' | 'started' | 'procOf'> | null
  rolling: Pick<HostRolling, 'adoptSpawned'> | null
  /** The profile's accounts, read now. Rejects on a damaged file (RepairNeeded). */
  readAccounts(): Promise<Account[]>
  /** Whether Astera's setting runs agents without permission checks, read now. Rejects on a damaged
   *  settings file, which may have said manual, so it is never read as the bypass. */
  bypass(): Promise<boolean>
  exists(p: string): boolean
  /** Tells the apps that take chat sessions back about a new chat proc. Never throws. */
  announceProc(procId: string): void
  /** The Host's session rows, `sessions list`'s. */
  list(): Promise<HostSession[]>
  log(m: string): void
}): (o: SessionCreate) => Promise<HostSession> {
  const rowOf = async (info: SessionInfo, kind: HostSession['kind']): Promise<HostSession> =>
    (await d.list()).find((r) => r.id === info.id && r.alive) ?? {
      id: info.id,
      kind,
      title: info.title ?? null,
      accountId: info.accountId ?? null,
      cwd: info.cwd ?? null,
      alive: true,
      state: 'unknown'
    }

  const terminal = async (o: SessionCreate): Promise<HostSession> => {
    if (!d.spawner)
      throw refusedBeforeActing(new Error('this Host starts no sessions: it was started without the agent CLI paths'))
    const info = await d.spawner.createSession({
      accountId: o.accountId,
      cwd: o.cwd,
      ...(o.title !== undefined ? { title: o.title } : {}),
      ...(o.prompt !== undefined ? { initialPrompt: o.prompt } : {}),
      rollAccountIds: o.rollAccountIds
    })
    d.log(`sessions create: terminal session ${info.id} on ${o.accountId} in ${o.cwd}`)
    return rowOf(info, 'terminal')
  }

  const chat = async (o: SessionCreate): Promise<HostSession> => {
    const chats = d.chats
    if (!chats) throw refusedBeforeActing(new Error('this Host starts no chat sessions: it was started without the agent CLI paths'))
    // Everything that can refuse comes before the spawn, so a refusal starts nothing.
    let account: Account
    let bypass: boolean
    try {
      const accounts = await d.readAccounts()
      const found = accounts.find((a) => a.id === o.accountId)
      if (!found) throw new Error(`unknown account: ${o.accountId}`)
      account = found
      if (!d.exists(o.cwd)) throw new Error(`CWD_MISSING: ${o.cwd} does not exist`)
      bypass = await d.bypass()
    } catch (err) {
      throw err instanceof Error ? refusedBeforeActing(err) : err
    }
    const info = chats.spawn({
      account,
      cwd: o.cwd,
      bypassPermissions: bypass,
      ...(o.title !== undefined ? { title: o.title } : {}),
      ...(o.prompt !== undefined ? { initialPrompt: o.prompt } : {}),
      ...(o.rollAccountIds.length > 0 ? { rollAccountIds: o.rollAccountIds } : {}),
      unattendedPermission: o.unattended ?? 'hold'
    })
    // The handshake and the first prompt settle before anyone else may take the session.
    if (!(await chats.started(info.id)))
      throw new Error(`chat session ${info.id} did not finish starting, so it was ended`)
    if (o.rollAccountIds.length > 0) d.rolling?.adoptSpawned(info, account)
    const procId = chats.procOf(info.id)
    if (procId !== null) d.announceProc(procId)
    d.log(`sessions create: chat session ${info.id} on ${o.accountId} in ${o.cwd}`)
    return rowOf(info, 'chat')
  }

  return (o) => (o.kind === 'chat' ? chat(o) : terminal(o))
}
