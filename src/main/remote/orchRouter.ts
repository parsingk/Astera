// Which Host an orchestration IPC call goes to (remote runtime design §2.7, C2 D1.1, D1.6, D1.7). A call with no
// `runtimeId`, or `'local'`, runs today's handler body exactly as it was: its guards, its project registration and its
// local fallbacks all live there. Any other id goes to that Runtime's client and nowhere else, so for a remote Runtime
// no local guard, fallback or write can run, and a Runtime that fails answers on its own without touching the local
// Host.
import type { CompletionDetail, OrchSnapshot, RunDetail } from '../../core/types'
import type { RemoteRuntimeClient, RuntimeView } from './runtimeClient'

export interface OrchHandlers {
  list(projectPath: string, runtimeId?: string): Promise<OrchSnapshot>
  runDetail(projectPath: string, runId: string, opts?: { journalPages?: unknown }, runtimeId?: string): Promise<RunDetail>
  completion(projectPath: string, runId: string, taskId: string, runtimeId?: string): Promise<CompletionDetail | null>
  command(projectPath: string, cmd: string, args: Record<string, unknown>, runtimeId?: string): Promise<{ status: number; body: unknown }>
}

export const LOCAL_RUNTIME = 'local'
export const isLocalRuntime = (runtimeId?: unknown): boolean => runtimeId === undefined || runtimeId === null || runtimeId === LOCAL_RUNTIME
/** A runtimeId from the renderer that is not a string names no Runtime (review M-1): it is never looked up. */
const NOT_A_RUNTIME = { code: 'RUNTIME_NOT_FOUND', message: 'a runtime id is a string' }

const EMPTY_DETAIL: RunDetail = { events: [], layers: [], deps: {}, cyclic: [] }
const offlineView = (runtimeId: unknown): RuntimeView => ({ runtimeId: typeof runtimeId === 'string' ? runtimeId : '', offline: true, stale: false, version: 0 })

export function createOrchRouter(a: {
  local: OrchHandlers
  remote: { client(runtimeId: string): Promise<RemoteRuntimeClient | { code: string; message: string }> }
  log?(m: string): void
}): OrchHandlers {
  const log = (m: string): void => {
    try {
      a.log?.(m)
    } catch {
      /* nowhere to say it */
    }
  }
  /** The client, or null with the reason logged: a Runtime nobody paired, or one whose client failed. */
  const clientOf = async (runtimeId: string): Promise<RemoteRuntimeClient | { code: string; message: string }> => {
    if (typeof runtimeId !== 'string') return NOT_A_RUNTIME
    try {
      return await a.remote.client(runtimeId)
    } catch (e) {
      return { code: 'RUNTIME_OFFLINE', message: e instanceof Error ? e.message : String(e) }
    }
  }
  const guarded = async <T>(runtimeId: string, what: string, fallback: T, fn: (c: RemoteRuntimeClient) => Promise<T>, onMissing: (m: { code: string; message: string }) => T): Promise<T> => {
    const c = await clientOf(runtimeId)
    if ('code' in c) return onMissing(c)
    try {
      return await fn(c)
    } catch (e) {
      log(`remote ${what} on ${runtimeId} failed: ${e instanceof Error ? e.message : String(e)}`)
      return fallback
    }
  }
  return {
    list: (projectPath, runtimeId) =>
      isLocalRuntime(runtimeId)
        ? a.local.list(projectPath)
        : guarded<OrchSnapshot>(
            runtimeId!,
            'list',
            { runs: [], projectFolderBusy: false, runtime: offlineView(runtimeId) },
            (c) => c.list(projectPath),
            () => ({ runs: [], projectFolderBusy: false, runtime: offlineView(runtimeId) })
          ),
    runDetail: (projectPath, runId, opts, runtimeId) =>
      isLocalRuntime(runtimeId)
        ? opts === undefined
          ? a.local.runDetail(projectPath, runId)
          : a.local.runDetail(projectPath, runId, opts)
        : guarded(runtimeId!, 'runDetail', EMPTY_DETAIL, (c) => c.runDetail(runId, opts), () => EMPTY_DETAIL),
    completion: (projectPath, runId, taskId, runtimeId) =>
      isLocalRuntime(runtimeId)
        ? a.local.completion(projectPath, runId, taskId)
        : guarded<CompletionDetail | null>(runtimeId!, 'completion', null, (c) => c.completion(runId, taskId), () => null),
    command: (projectPath, cmd, args, runtimeId) =>
      isLocalRuntime(runtimeId)
        ? a.local.command(projectPath, cmd, args)
        : guarded(
            runtimeId!,
            'command',
            { status: 503, body: { error: `the Runtime ${runtimeId} could not be asked`, code: 'RUNTIME_OFFLINE' } },
            (c) => c.command(cmd, args ?? {}),
            (m) => ({ status: m.code === 'RUNTIME_NOT_FOUND' ? 404 : 503, body: { error: m.message, code: m.code } })
          )
  }
}
