// The agent sessions this Host holds, as `astera sessions` sees them (CLI phase C): the answers to
// `listSessions`, `readSession` and `writeSession` in the command layer, out of the two registries.
//
// **Every id here is the app's id for the session, never the Host's id for the process.** The app
// mints a pty id of its own at spawn (main/host/ptyFactory.ts) and carries the session id in the
// note, as `meta.id` — that is `ASTERA_SESSION` inside the session and a Dispatch's `sessionId`, the
// id a person or an agent already has. So every lookup goes through the note.
//
// **Which notes are sessions.** Four kinds reach the Host (core/host/protocol.ts `PtyMeta`):
// - `session` — an agent CLI in a pty (core/sessions/manager.ts). Listed, as `terminal`.
// - `chat` — a chat session's line process, in the other registry (main/chat/manager.ts). Listed.
// - `terminal` — a plain shell tab (main/terminalManager.ts): no account, no agent. Not listed.
// - `run` — a run configuration's process (main/runManager.ts), a build or a server. Not listed.
//
// Imports nothing outside core, for the reason registry.ts gives: this bundles into the Host.
import type { HostSession } from '../core/orchestration/command'
import type { PtyEntry } from '../core/host/protocol'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'

/** The three the command layer is handed. `Required`, because the Host always has them. */
export interface HostSessions {
  listSessions(): HostSession[]
  readSession(id: string): string
  writeSession(id: string, data: string): void
}

/** A note key as the app wrote it, or `null` — the note is the app's, and nothing checks its keys. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const rowOf = (e: PtyEntry, kind: HostSession['kind']): HostSession => {
  const restore = e.meta?.restore ?? {}
  return {
    id: e.meta!.id,
    kind,
    title: text(restore.title),
    accountId: text(restore.accountId),
    cwd: text(restore.cwd),
    alive: e.alive
  }
}

export function registrySessions(a: {
  ptys: Pick<PtyRegistry, 'list' | 'buffer' | 'write'>
  procs: Pick<ProcRegistry, 'list'>
}): HostSessions {
  /** The pty behind an agent session's id — only an agent session's, so a shell tab's id is nobody. */
  const ptyOf = (id: string): string | null =>
    a.ptys.list().find((e) => e.meta?.kind === 'session' && e.meta.id === id)?.id ?? null
  return {
    listSessions: () => [
      ...a.ptys.list().filter((e) => e.meta?.kind === 'session').map((e) => rowOf(e, 'terminal')),
      ...a.procs.list().filter((e) => e.meta?.kind === 'chat').map((e) => rowOf(e, 'chat'))
    ],
    readSession: (id) => {
      const pty = ptyOf(id)
      return pty === null ? '' : a.ptys.buffer(pty)
    },
    writeSession: (id, data) => {
      const pty = ptyOf(id)
      if (pty !== null) a.ptys.write(pty, data)
    }
  }
}
