// The one way a Job form or action reaches its Runtime (remote runtime design Phase 7, N10). The local door is
// today's path exactly: `orch.command` with no runtime id, this computer's accounts and their login probe, and the
// project's run configurations (ADR-004, Q1). The remote door sends everything to the paired Runtime as `orch-call`
// through main's router: commands, its own accounts with the signed-in flag it decided (N5), and its own run
// configurations. A read-only pairing refuses a control command here, before it is sent; the Runtime would refuse it
// too (controllerGate), but a button that does nothing until a round trip says no is not a disabled button.
import type { Account, Provider } from '../../../core/types'
import { remoteMutation } from '../../../core/remote/targets'

export type CommandReply = { status: number; body: unknown }
export type RunConfigRow = { id: string; name: string; type?: string }

export interface OrchDoor {
  /** undefined for this computer. */
  runtimeId?: string
  /** The project argument `orch.command` takes: a local path, or the Runtime's project key. */
  projectKey: string
  /** Why control is off (a read-only pairing), or null. */
  readOnlyReason: string | null
  command(cmd: string, args: Record<string, unknown>): Promise<CommandReply>
  accounts(): Promise<Account[]>
  /** The ids of the accounts that can run now. */
  signedInIds(accounts: Account[]): Promise<Set<string>>
  /** Run configurations for a Task's validation: local by the project folder, remote by the Run's Job. */
  runConfigs(runId: string): Promise<RunConfigRow[]>
}

export interface DoorApi {
  orch: { command(projectPath: string, cmd: string, args: Record<string, unknown>, runtimeId?: string): Promise<CommandReply> }
  accounts: { list(): Promise<Account[]>; loginStatus(id: string): Promise<boolean> }
  run: { list(projectPath: string): Promise<{ configs: RunConfigRow[] }> }
}

export function localDoor(api: DoorApi, projectPath: string): OrchDoor {
  return {
    projectKey: projectPath,
    readOnlyReason: null,
    command: (cmd, args) => api.orch.command(projectPath, cmd, args),
    accounts: () => api.accounts.list(),
    // In parallel: one probe per account, waited on one after another, is as slow as the accounts are many.
    signedInIds: async (accounts) =>
      new Set((await Promise.all(accounts.map(async (a) => ((await api.accounts.loginStatus(a.id)) ? a.id : null)))).filter((id): id is string => id !== null)),
    runConfigs: async () => (await api.run.list(projectPath)).configs
  }
}

/** The signed-in flag the Runtime gave with each of its accounts, kept beside the Account the forms take. */
const signedIn = new WeakMap<Account, boolean>()

export function remoteDoor(
  api: DoorApi,
  a: {
    runtimeId: string
    projectKey: string
    permission: string
    readOnlyReason: string
    /** A change went through: the view reads the Runtime again now, since it pushes nothing to this app yet. */
    onChanged?(): void
  }
): OrchDoor {
  // An unknown permission level is read only, as the Runtime's own gate reads it (controllerGate).
  const readOnly = a.permission !== 'full-control'
  const send = (cmd: string, args: Record<string, unknown>): Promise<CommandReply> => api.orch.command(a.projectKey, cmd, args, a.runtimeId)
  const ok = (r: CommandReply): boolean => r.status >= 200 && r.status < 300
  return {
    runtimeId: a.runtimeId,
    projectKey: a.projectKey,
    readOnlyReason: readOnly ? a.readOnlyReason : null,
    command: async (cmd, args) => {
      if (readOnly && remoteMutation(cmd)) return { status: 403, body: { error: a.readOnlyReason, code: 'RUNTIME_PERMISSION_DENIED' } }
      const r = await send(cmd, args)
      if (ok(r) && remoteMutation(cmd)) a.onChanged?.()
      return r
    },
    accounts: async () => {
      // Never this computer's accounts: a Runtime that cannot say has none to offer here.
      const r = await send('accounts-list', {}).catch(() => null)
      if (!r || !ok(r) || !Array.isArray(r.body)) return []
      return (r.body as Array<{ id?: unknown; label?: unknown; provider?: unknown; signedIn?: unknown }>)
        .filter((x) => typeof x.id === 'string')
        .map((x) => {
          const account: Account = {
            id: x.id as string,
            label: typeof x.label === 'string' ? x.label : (x.id as string),
            // A Runtime path and a colour this computer never uses: the forms read id, label and provider.
            configDir: '',
            color: '#888888',
            createdAt: '',
            ...(x.provider === 'claude' || x.provider === 'codex' ? { provider: x.provider as Provider } : {})
          }
          signedIn.set(account, x.signedIn === true)
          return account
        })
    },
    signedInIds: async (accounts) => new Set(accounts.filter((x) => signedIn.get(x) === true).map((x) => x.id)),
    runConfigs: async (runId) => {
      // run-configs-list takes a Job id only (the CLI's rule): the Run is resolved to its Job first.
      const job = await send('jobs-get', { id: runId }).catch(() => null)
      const jobId = job && ok(job) ? (job.body as { id?: unknown } | null)?.id : undefined
      if (typeof jobId !== 'string') return []
      const r = await send('run-configs-list', { job: jobId }).catch(() => null)
      return r && ok(r) && Array.isArray(r.body) ? (r.body as RunConfigRow[]) : []
    }
  }
}
