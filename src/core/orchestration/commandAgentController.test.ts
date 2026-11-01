// Every local agent rule applies to a remote controller that is an agent (remote governance design §7.3): an MCP client
// or a CLI inside an agent session on another computer meets the answer it would get from the same seat locally. A
// controller that did not say what it is (`unsaid`) is treated as an agent; when it is a CLI, its refusal also says to
// update Astera there (UNSAID_CLI_NOTE).
//
// The sites that treat an agent apart, and what a controller reaches (grep of command.ts, host/orch.ts and
// host/remoteSessions.ts for agentCaller(, fromAgent, startedBy: 'agent', agentShell():
// - command.ts profileBypassRefusal (via profileFor): jobs-create, run-create, task-create, tasks-add, sessions-create.
//   Reached by a controller; tested here (jobs-create).
// - command.ts startRefusal (handleCommand's gate before the state): run-start, jobs-run, run-resume, runs-resume,
//   runs-reconverge, worker-start. Reached; tested here (run-start).
// - command.ts task-create's inherited profile (agentCaller then inheritedBypassRefusal, which is startRefusal). Reached
//   through the same agentCaller; covered by the startRefusal case.
// - command.ts fromAgentSession: a Run's external coordinator and run-scoped reads. Needs a real session id, which a
//   controller never has (orch.ts drops it), so it is not a rule a controller reaches.
// - command.ts sessions-send's fromAgent: the prompt refusal. Reached; tested here.
// - command.ts sessions-create's startedBy. Reached; tested here.
// - host/orch.ts agentShell: pair-create and the app-only commands. The app or a shell's CLI only; a controller's
//   command list (controllerGate.ts) holds none of them, so it never gets that far.
// - host/remoteSessions.ts sessions-answer (chats-answer's rule) and sessions-input (sessions-send's prompt rule).
//   Tested in host/remoteSessions.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { APP_CALLER } from '../host/driver'
import { UNSAID_CLI_NOTE } from '../host/controllerGate'
import type { ControllerKind, ControllerPrincipal } from '../host/orchProtocol'
import type { AgentProfile } from '../agentProfiles/types'
import { absPath } from '../testPaths'

const NOW = '2026-11-01T00:00:00.000Z'
const ROOT = absPath('p')

const P = (over: Partial<AgentProfile>): AgentProfile => ({
  id: 'ap_b', name: 'Unattended', status: 'active', accountIds: ['acc1'], mcpExclude: [], permission: 'bypass', sandbox: false, createdAt: NOW, updatedAt: NOW, ...over
})

const makeDeps = (yolo: boolean, extra: Partial<OrchServerDeps> = {}): OrchServerDeps => {
  const box: { state: OrchState } = { state: { ...emptyState(), projects: [{ id: 'prj_p', path: ROOT, name: 'p', addedAt: NOW }] } }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: ROOT, specPath: 'spec.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc1', label: 'One', provider: 'claude' as const }],
    readWorker: async () => '',
    now: () => NOW,
    readAgentProfiles: async () => ({ version: 1, profiles: [P({})] }),
    appWideYolo: async () => yolo,
    ...extra
  } as OrchServerDeps
}

type Caller = { sessionId: string; role: 'controller'; principal: ControllerPrincipal }
const controller = (kind: ControllerKind | undefined, surface?: ControllerPrincipal['surface']): Caller => ({
  sessionId: '',
  role: 'controller',
  principal: { clientId: 'cli_1', name: 'laptop', permission: 'full-control', ...(kind !== undefined ? { kind } : {}), ...(surface ? { surface } : {}) }
})
const reasonOf = (r: { body: unknown }): unknown => (r.body as { reason?: unknown }).reason
const errorOf = (r: { body: unknown }): string => (r.body as { error: string }).error
const jobsCreate = (deps: OrchServerDeps, caller: Caller) =>
  handleCommand(deps, caller, 'jobs-create', { objective: 'o', cwd: ROOT, agentProfile: 'ap_b' })

describe('a bypass profile, asked by a remote controller (remote governance design §7.3)', () => {
  it('an agent controller is refused jobs-create as a bypass profile while the setting is off', async () => {
    for (const surface of ['mcp', 'cli'] as const) {
      const deps = makeDeps(false)
      const r = await jobsCreate(deps, controller('agent', surface))
      expect([r.status, reasonOf(r)], surface).toEqual([403, 'agent-profile-bypass-refused'])
      expect(errorOf(r)).toContain('an agent on another computer (an MCP client or a CLI inside an agent session)')
      expect(errorOf(r)).not.toContain(UNSAID_CLI_NOTE)
      expect(deps.getState().jobs).toHaveLength(0)
    }
  })

  it('a person controller is not asked', async () => {
    for (const surface of ['desktop', 'cli'] as const) {
      const appWideYolo = vi.fn(async () => false)
      const r = await jobsCreate(makeDeps(false, { appWideYolo }), controller('person', surface))
      expect(r.status, `${surface} ${JSON.stringify(r.body)}`).toBe(200)
      expect(appWideYolo).not.toHaveBeenCalled()
    }
  })

  it('an unsaid controller is refused, and the refusal says to update Astera on that computer', async () => {
    const r = await jobsCreate(makeDeps(false), controller('unsaid', 'cli'))
    expect([r.status, reasonOf(r)]).toEqual([403, 'agent-profile-bypass-refused'])
    expect(errorOf(r).endsWith(UNSAID_CLI_NOTE)).toBe(true)
  })

  // The controller's ruling on the Task 5 review: the note is about an older Astera CLI, so a client that named no
  // surface (a third-party one) is refused without it
  it('an unsaid controller that named no surface is refused without the CLI note', async () => {
    const r = await jobsCreate(makeDeps(false), controller('unsaid'))
    expect([r.status, reasonOf(r)]).toEqual([403, 'agent-profile-bypass-refused'])
    expect(errorOf(r)).not.toContain(UNSAID_CLI_NOTE)
  })

  it('a principal with no kind reads as unsaid', async () => {
    const r = await jobsCreate(makeDeps(false), controller(undefined, 'cli'))
    expect([r.status, reasonOf(r)]).toEqual([403, 'agent-profile-bypass-refused'])
    expect(errorOf(r).endsWith(UNSAID_CLI_NOTE)).toBe(true)
  })

  it('with the setting on, the agent controller may', async () => {
    const r = await jobsCreate(makeDeps(true), controller('agent', 'mcp'))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('run-start of a Job held by a bypass profile is refused to an agent controller', async () => {
    const deps = makeDeps(false)
    await handleCommand(deps, { sessionId: APP_CALLER }, 'run-create', { objective: 'o', cwd: ROOT, agentProfileId: 'ap_b', auto: true })
    const jobId = deps.getState().jobs[0].id
    const r = await handleCommand(deps, controller('agent', 'mcp'), 'run-start', { run: jobId })
    expect([r.status, reasonOf(r)], JSON.stringify(r.body)).toEqual([403, 'agent-profile-bypass-refused'])
    expect(deps.getState().runs).toHaveLength(0)
    // A person controller starts it
    expect((await handleCommand(deps, controller('person', 'desktop'), 'run-start', { run: jobId })).status).toBe(200)
  })
})

describe('sessions a remote controller starts and types into (remote governance design §7.3)', () => {
  const row = (over: Partial<HostSession> = {}): HostSession => ({ id: 'sess_new', kind: 'terminal', title: 't', accountId: 'acc1', cwd: ROOT, alive: true, state: 'unknown', ...over })

  it("a controller's sessions-create marks startedBy agent only for an agent controller", async () => {
    const startedBy = async (caller: Caller): Promise<unknown> => {
      const createSession = vi.fn(async () => row())
      const r = await handleCommand(makeDeps(false, { createSession }), caller, 'sessions-create', { account: 'acc1', cwd: ROOT })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return (createSession.mock.calls[0] as unknown as [{ startedBy?: unknown }])[0].startedBy
    }
    expect(await startedBy(controller('agent', 'mcp'))).toBe('agent')
    expect(await startedBy(controller('unsaid'))).toBe('agent')
    expect(await startedBy(controller('person', 'desktop'))).toBeUndefined()
  })

  it('sessions-send from an agent controller into a terminal at a permission prompt is refused with nothing typed', async () => {
    const rig = () => {
      const sendSession = vi.fn(async () => {})
      const deps = makeDeps(false, {
        listSessions: async () => [row({ id: 't1', state: 'waiting' })],
        readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
        sendSession,
        readChat: async () => [],
        chatSend: vi.fn(async () => ({ sent: true as const })),
        sessionTurn: vi.fn(async () => ({ alive: true, state: 'waiting' as const, prompt: 'permission' as const }))
      } as Partial<OrchServerDeps>)
      return { deps, sendSession }
    }
    const agent = rig()
    const r = await handleCommand(agent.deps, controller('agent', 'cli'), 'sessions-send', { id: 't1', text: '1' })
    expect(r.status).toBe(409)
    expect(errorOf(r)).toContain('an agent on another computer')
    expect(agent.sendSession).not.toHaveBeenCalled()
    const unsaid = rig()
    const u = await handleCommand(unsaid.deps, controller('unsaid', 'cli'), 'sessions-send', { id: 't1', text: '1' })
    expect(u.status).toBe(409)
    expect(errorOf(u).endsWith(UNSAID_CLI_NOTE)).toBe(true)
    expect(unsaid.sendSession).not.toHaveBeenCalled()
    // A person controller answers it
    const person = rig()
    expect((await handleCommand(person.deps, controller('person', 'desktop'), 'sessions-send', { id: 't1', text: '1' })).status).toBe(200)
    expect(person.sendSession).toHaveBeenCalledTimes(1)
  })
})
