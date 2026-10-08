// Remote Runtime Phase 10 acceptance in one process: a Runtime (the Host's orchestration with its git reader, the
// recorder over real git, the Gateway link and the Gateway on pinned TLS) and a paired read-only controller. A Run works
// in its own worktree: renamed, Unicode, spaced, case-only renamed, deleted and binary files. The controller lists them
// and reads each diff by id, equal to `git diff` there; after the worktree is merged and removed, the same list and
// diffs come from the recorded range in the project. A path is never taken for a file id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { attachGatewayLink } from './gatewayLink'
import { createControllerRegistry } from './controllers'
import { createRunGitRecorder } from './runGitRecorder'
import { emptyState } from '../core/orchestration/state'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime } from '../core/remote/client'
import { openRemoteLink, type RemoteLink } from '../core/remote/link'
import { readChanges, readFileDiff } from '../core/git/changes'
import { git as realGit } from '../core/worktrees/git'
import { startGateway } from '../cli/runtime/gateway'
import type { ChangedFile, ChangedFilesReply } from '../core/git/changedFile'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p10', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()

let dir: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p10-'))
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const g = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
const gitDiff = (cwd: string, args: string[]): string => g(cwd, ['-c', 'core.quotePath=false', 'diff', '-M', ...args])
const write = async (root: string, rel: string, text: string | Buffer): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}

async function runtime() {
  const project = path.join(dir, 'repo')
  await fs.mkdir(project)
  g(project, ['init', '-q', '-b', 'main'])
  g(project, ['config', 'user.email', 't@t'])
  g(project, ['config', 'user.name', 'T'])
  await write(project, 'keep.txt', 'a\nb\nc\n')
  await write(project, 'gone.txt', 'x\n')
  await write(project, 'Readme.md', 'hello\n')
  await write(project, 'old name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  g(project, ['add', '-A'])
  g(project, ['commit', '-q', '-m', 'base'])
  const profile = path.join(dir, 'profile')
  await fs.mkdir(profile)
  await fs.writeFile(path.join(profile, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
  const controllers = createControllerRegistry()
  let onState: (s: ReturnType<typeof orch.state>) => void = () => {}
  const orch = createHostOrch({
    profileDir: profile,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => new Date().toISOString(),
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => false,
    onState: (s) => onState(s),
    log: () => {},
    controllers,
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
    changes: { read: (repo, base, head) => readChanges(repo, base, head), diff: (repo, base, head, f) => readFileDiff(repo, base, head, f) }
  })
  await orch.ready()
  const recorder = createRunGitRecorder({
    record: (args) => orch.handle('runs-git-record', args),
    headOf: async (cwd) => {
      const r = await realGit(['rev-parse', 'HEAD'], { cwd })
      return r.ok ? r.stdout : null
    },
    mergeBase: async (cwd, ref) => {
      const r = await realGit(['merge-base', 'HEAD', ref], { cwd })
      return r.ok ? r.stdout : null
    },
    baseRefOf: () => 'main',
    isDir: (p) => p !== '',
    log: () => {}
  })
  onState = (s) => recorder.onState(s)
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: { call: (c) => orch.call(c) },
    hello: () => ({ runtimeId: 'rt_p10', displayName: 'Office', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: process.platform, pathStyle: 'windows', capabilities: ['remote.changed-files', 'remote.diff'] }),
    log: () => {},
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {}
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost } })
  if ('error' in started) throw new Error(started.error.message)
  cleanups.push(async () => {
    link.detach()
    await started.close()
  })
  return { orch, recorder, controllers, port: started.port, project }
}

async function controller(rt: Awaited<ReturnType<typeof runtime>>): Promise<RemoteLink> {
  const pairing = rt.controllers.createPairing({ permission: 'read-only' })
  const first = await connectRuntime({ host: '127.0.0.1', port: rt.port, pin: identity.spkiSha256 })
  const paired = await first.redeem(pairing.code, 'laptop', {})
  first.close()
  const l = openRemoteLink({ target: { runtimeId: 'rt_p10', address: '127.0.0.1', port: rt.port, fingerprint: identity.spkiSha256, token: paired.token }, client: { surface: 'desktop' } })
  cleanups.push(() => l.close())
  return l
}

const body = <T>(r: unknown): T => (r as { body: T }).body
const until = async (check: () => boolean): Promise<void> => {
  const end = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Remote Runtime Phase 10 acceptance (changed files and diff over the link)', { timeout: 60_000 }, () => {
  it('a read-only controller lists a Run’s changes and reads each diff by id, before and after its worktree is merged away', async () => {
    const rt = await runtime()
    const host = (cmd: string, args: Record<string, unknown>) => rt.orch.handle(cmd, args)
    const runId = body<{ id: string }>(await host('run-create', { objective: 'o', cwd: rt.project })).id
    const worktree = path.join(dir, 'wt')
    g(rt.project, ['worktree', 'add', '-q', '-b', 'feat', worktree])
    expect((await host('run-worktree-set', { run: runId, worktree })).status).toBe(200)
    // The recorder saw the Run get its worktree and recorded where it forked.
    const base = g(rt.project, ['rev-parse', 'HEAD']).trim()
    await until(() => rt.orch.state().runs.find((r) => r.id === runId)?.git?.base === base)

    await write(worktree, 'keep.txt', 'a\nB\nc\nd\n')
    await fs.rm(path.join(worktree, 'gone.txt'))
    await fs.mkdir(path.join(worktree, 'dir'), { recursive: true })
    g(worktree, ['mv', 'old name.txt', 'dir/새 이름.txt'])
    await write(worktree, 'dir/새 이름.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n')
    g(worktree, ['mv', 'Readme.md', 'README.md'])
    await write(worktree, 'has space/한글.txt', 'z\n')
    await write(worktree, 'img.bin', Buffer.from([0, 1, 2, 0, 255, 0]))
    g(worktree, ['add', '-A'])
    g(worktree, ['commit', '-q', '-m', 'work'])
    // Uncommitted, while the Run is at work: counted too.
    await write(worktree, 'keep.txt', 'a\nB\nc\nd\ne\n')

    const ctl = await controller(rt)
    const live = body<ChangedFilesReply>(await ctl.call('runs-changed-files', { runId }))
    expect(live.git).toMatchObject({ base, head: null })
    const byPath = (files: ChangedFile[]) => Object.fromEntries(files.map((f) => [f.path, f]))
    const lf = byPath(live.git!.files)
    expect(Object.keys(lf).sort()).toEqual(['README.md', 'dir/새 이름.txt', 'gone.txt', 'has space/한글.txt', 'img.bin', 'keep.txt'])
    expect(lf['README.md']).toMatchObject({ status: 'renamed', oldPath: 'Readme.md' })
    expect(lf['dir/새 이름.txt']).toMatchObject({ status: 'renamed', oldPath: 'old name.txt' })
    expect(lf['gone.txt'].status).toBe('deleted')
    expect(lf['img.bin']).toMatchObject({ status: 'added', binary: true })
    expect(lf['keep.txt']).toMatchObject({ status: 'modified', additions: 3, deletions: 1 })
    for (const f of live.git!.files) {
      const d = body<{ diff: string }>(await ctl.call('runs-diff', { runId, fileId: f.id }))
      expect(d.diff).toBe(gitDiff(worktree, [base, '--', ...(f.oldPath ? [f.oldPath] : []), f.path]))
    }

    // The work is committed, merged into the project, and its worktree and branch removed.
    g(worktree, ['commit', '-q', '-am', 'last'])
    const tip = g(worktree, ['rev-parse', 'HEAD']).trim()
    await rt.recorder.beforeIntegrate(rt.project, [worktree])
    expect(rt.orch.state().runs.find((r) => r.id === runId)?.git).toEqual({ base, head: tip })
    g(rt.project, ['merge', '-q', '--no-edit', 'feat'])
    g(rt.project, ['worktree', 'remove', '--force', worktree])
    g(rt.project, ['branch', '-D', 'feat'])

    const after = body<ChangedFilesReply>(await ctl.call('runs-changed-files', { runId }))
    expect(after.git).toMatchObject({ base, head: tip })
    expect(Object.keys(byPath(after.git!.files)).sort()).toEqual(Object.keys(lf).sort())
    for (const f of after.git!.files) {
      const d = body<{ diff: string }>(await ctl.call('runs-diff', { runId, fileId: f.id }))
      expect(d.diff).toBe(gitDiff(rt.project, [base, tip, '--', ...(f.oldPath ? [f.oldPath] : []), f.path]))
    }

    // Never a path, and never an id the list does not have.
    expect(((await ctl.call('runs-diff', { runId, fileId: 'keep.txt' })) as { status: number }).status).toBe(404)
    expect(((await ctl.call('runs-diff', { runId, fileId: '../../etc/passwd' })) as { status: number }).status).toBe(404)
  })

  it('a Run from before its range was kept answers no git list, and why', async () => {
    const rt = await runtime()
    const runId = body<{ id: string }>(await rt.orch.handle('run-create', { objective: 'o', cwd: rt.project })).id
    const ctl = await controller(rt)
    expect(body(await ctl.call('runs-changed-files', { runId }))).toMatchObject({ git: null, unavailable: 'not-recorded', reported: [] })
    // The Host's own record is refused to a controller.
    expect(((await ctl.call('runs-git-record', { runId, base: 'x' })) as { status: number }).status).toBe(403)
    expect(rt.orch.state().runs[0].git).toBeUndefined()
  })
})
