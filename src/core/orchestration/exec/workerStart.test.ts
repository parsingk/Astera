import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startWorkerWithChain, startCoordinatorSession, preTrustWorkspace } from './workerStart'
import { WorkerTails, TAIL_EMPTY } from './tail'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../state'
import { makeDescriptors } from '../../providers/descriptor'
import type { Account } from '../../types'

const NOW = '2026-09-24T00:00:00.000Z'
const acct = (id: string, provider: 'claude' | 'codex' = 'claude'): Account =>
  ({ id, label: id, configDir: `D:/cfg/${id}`, color: '#888', createdAt: NOW, provider })
const stateWithTask = (accountIds?: string[]): { s: OrchState; taskId: string } => {
  const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
  const t = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [], ...(accountIds ? { accountIds } : {}) }, NOW)
  if (!t.ok) throw new Error(t.error)
  return { s: t.state, taskId: t.value.id }
}
const args = (taskId: string, accountId = 'a1') => ({
  dispatchId: 'dsp_1', taskId, title: 't', spec: 's', provider: 'claude' as const, accountId, runCwd: 'D:/p', worktree: 'current'
})

describe('startWorkerWithChain', () => {
  // Property 4 of the convergence design, formerly a source-text guard over ipc.ts (R11).
  it('hands the coordinator the chain rollChainFor built from the Task\'s own accounts', async () => {
    const { s, taskId } = stateWithTask(['a1', 'a2'])
    const startWorker = vi.fn().mockResolvedValue({ sessionId: 'ses_1', cwd: 'D:/p', specPath: 'D:/s.md' })
    await startWorkerWithChain({
      getState: () => s, accounts: async () => [acct('a1'), acct('a2')], loginStatus: async () => true,
      coordinator: { startWorker }, tails: new WorkerTails(), log: () => {}
    }, args(taskId))
    expect(startWorker.mock.calls[0][0].rollAccountIds).toEqual(['a1', 'a2'])
    expect(startWorker.mock.calls[0][0].dispatchId).toBe('dsp_1')
  })

  it('asks no login status when the Task names no accounts, and the chain is the one account', async () => {
    const { s, taskId } = stateWithTask()
    const loginStatus = vi.fn()
    const startWorker = vi.fn().mockResolvedValue({ sessionId: 'ses_1', cwd: 'D:/p', specPath: 'D:/s.md' })
    await startWorkerWithChain({ getState: () => s, accounts: async () => [acct('a1')], loginStatus, coordinator: { startWorker }, tails: new WorkerTails(), log: () => {} }, args(taskId))
    expect(loginStatus).not.toHaveBeenCalled()
    expect(startWorker.mock.calls[0][0].rollAccountIds).toEqual(['a1'])
  })

  it('falls back to the one account and says so when the login lookup throws', async () => {
    const { s, taskId } = stateWithTask(['a1', 'a2'])
    const logs: string[] = []
    const startWorker = vi.fn().mockResolvedValue({ sessionId: 'ses_1', cwd: 'D:/p', specPath: 'D:/s.md' })
    await startWorkerWithChain({ getState: () => s, accounts: async () => [acct('a1'), acct('a2')], loginStatus: async () => { throw new Error('keychain') }, coordinator: { startWorker }, tails: new WorkerTails(), log: (m) => logs.push(m) }, args(taskId))
    expect(startWorker.mock.calls[0][0].rollAccountIds).toEqual(['a1'])
    expect(logs.join('\n')).toMatch(/could not read login status/)
  })

  it('starts the tail for the dispatch on the session the coordinator returned', async () => {
    const { s, taskId } = stateWithTask()
    const tails = new WorkerTails()
    await startWorkerWithChain({ getState: () => s, accounts: async () => [acct('a1')], loginStatus: async () => true,
      coordinator: { startWorker: vi.fn().mockResolvedValue({ sessionId: 'ses_9', cwd: 'D:/p', specPath: 'D:/s.md' }) }, tails, log: () => {} }, args(taskId))
    expect(tails.read('dsp_1')).toBe(TAIL_EMPTY)
    tails.push('ses_9', 'hello\n')
    expect(tails.read('dsp_1')).toBe('hello')
  })
})

describe('startCoordinatorSession', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-coord-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  it('writes the brief, pre-trusts, and spawns with a one-account chain and the Run title', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'ses_c' })
    const preTrust = vi.fn().mockResolvedValue(undefined)
    const r = await startCoordinatorSession({ specsDir: dir, preTrust, bypassPermissions: async () => true, spawn, log: () => {} },
      { runId: 'run_abcdefghijklmnop', cwd: 'D:/p', accountId: 'a1', brief: 'BRIEF' })
    expect(r).toEqual({ sessionId: 'ses_c' })
    expect(await fs.readFile(path.join(dir, 'coordinator-run_abcdefghijklmnop.md'), 'utf8')).toBe('BRIEF')
    expect(preTrust).toHaveBeenCalledWith('a1', 'D:/p')
    expect(spawn.mock.calls[0][0]).toMatchObject({ accountId: 'a1', cwd: 'D:/p', bypassPermissions: true, rollAccountIds: ['a1'], title: 'Coordinator · run_abcdefgh' })
  })
})

describe('preTrustWorkspace', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-trust-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  it('marks a claude project trusted in the account\'s own .claude.json when the account is not ambient', async () => {
    const account: Account = { id: 'a1', label: 'a', configDir: path.join(dir, 'cfg'), color: '#888', createdAt: NOW, provider: 'claude' }
    await fs.mkdir(account.configDir, { recursive: true })
    await preTrustWorkspace({ account, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), descriptors: makeDescriptors(process.platform), log: () => {} })
    expect(await fs.readFile(path.join(account.configDir, '.claude.json'), 'utf8')).toMatch(/hasTrustDialogAccepted/)
  })
  it('does nothing for an unknown account', async () => {
    await expect(preTrustWorkspace({ account: undefined, cwd: dir, homeDir: dir, descriptors: makeDescriptors(process.platform), log: () => {} })).resolves.toBeUndefined()
  })
})
