import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { ClientMessage } from '../../core/host/protocol'
import type { LspProblem } from '../../core/lsp/model'
import { createHostLspView, createInterpreterLookup, venvInterpreterFor } from './hostLsp'
import { venvInterpreterPaths } from '../../core/run/python'
import { languageServersOf } from '../../core/settings/languageServers'

// Phase 3 Part 3: the app's side of the Host's language servers
const A = path.resolve('rootA')
const B = path.resolve('rootB')
const problem: LspProblem = { line: 3, column: 5, endLine: 3, endColumn: 9, severity: 'error', message: 'x', code: '2322' }

function rig(features: string[] = ['lsp']) {
  const status = { connected: true, features }
  const sent: ClientMessage[] = []
  const changed = vi.fn()
  const stateChanged = vi.fn()
  const interpreterFor = vi.fn(async (root: string) => (root === B ? path.resolve('py', 'python.exe') : null))
  const view = createHostLspView({
    status: () => status,
    send: (m) => {
      sent.push(m)
      return true
    },
    interpreterFor,
    changed,
    stateChanged,
    log: () => {}
  })
  return { view, status, sent, changed, stateChanged, interpreterFor }
}

describe('createHostLspView', () => {
  it('sends the open set with interpreters only for roots with Python files', async () => {
    const r = rig()
    const open = [{ path: path.join(A, 'a.ts'), root: A }, { path: path.join(B, 'b.py'), root: B }]
    await r.view.setOpen(open)
    expect(r.sent).toEqual([{ t: 'lsp-sync', open, interpreters: { [B]: path.resolve('py', 'python.exe') } }])
    expect(r.interpreterFor).toHaveBeenCalledTimes(1)
    expect(r.interpreterFor).toHaveBeenCalledWith(B)
  })

  it('sends it again on connect, and nothing to a Host without lsp', async () => {
    const r = rig([])
    const open = [{ path: path.join(A, 'a.ts'), root: A }]
    await r.view.setOpen(open)
    r.view.saved([path.join(A, 'a.ts')])
    expect(r.sent).toEqual([])
    r.status.features = ['lsp']
    await r.view.connected()
    expect(r.sent).toEqual([{ t: 'lsp-sync', open, interpreters: {} }])
    r.view.saved([path.join(A, 'a.ts')])
    expect(r.sent[1]).toEqual({ t: 'lsp-saved', paths: [path.join(A, 'a.ts')] })
  })

  it('replaces a file’s problems per push and clears all when the Host drops', () => {
    const r = rig()
    const file = { root: A, path: path.join(A, 'a.ts'), server: 'typescript' as const, producedAt: '2026-11-26T01:00:00.000Z', problems: [problem] }
    r.view.pushed({ t: 'lsp-diagnostics', files: [file, { ...file, path: path.join(B, 'b.ts'), root: B }] })
    expect(r.view.files(A)).toEqual([file])
    expect(r.changed).toHaveBeenCalledTimes(1)
    r.view.pushed({ t: 'lsp-diagnostics', files: [{ ...file, problems: [] }] })
    expect(r.view.files(A)).toEqual([])
    r.view.pushed({ t: 'lsp-diagnostics', files: [file] })
    r.view.pushed({ t: 'lsp-state', servers: [{ server: 'typescript', root: A, status: 'running' }] })
    expect(r.stateChanged).toHaveBeenLastCalledWith([{ server: 'typescript', root: A, status: 'running' }])
    expect(r.view.servers()).toEqual([{ server: 'typescript', root: A, status: 'running' }])
    r.status.connected = false
    r.view.status()
    expect(r.view.files(A)).toEqual([])
    expect(r.view.files(B)).toEqual([])
    expect(r.view.servers()).toEqual([])
    expect(r.stateChanged).toHaveBeenLastCalledWith([])
  })

  it('sends only the newest open set when an older one is still asking for interpreters', async () => {
    const r = rig()
    let release: () => void = () => {}
    r.interpreterFor.mockImplementationOnce(() => new Promise((res) => (release = () => res(null))))
    const first = r.view.setOpen([{ path: path.join(B, 'old.py'), root: B }])
    const second = r.view.setOpen([{ path: path.join(A, 'a.ts'), root: A }])
    await second
    release()
    await first
    expect(r.sent).toEqual([{ t: 'lsp-sync', open: [{ path: path.join(A, 'a.ts'), root: A }], interpreters: {} }])
  })
})

// pyright's interpreter for a root (design §5 Part 3, the person's decision): the project's venv once allowed for it,
// else the one the person picked, else the first found outside the project; never a batch file. Final review C1: nothing
// inside the project runs to find it: an allowed venv is only checked to exist, and the search outside skips the project
describe('createInterpreterLookup', () => {
  const venv = venvInterpreterPaths(A, process.platform)[0]
  const outside = path.resolve('py', 'python.exe')
  const rig = (existing: string[] = [venv]) => {
    const exists = vi.fn(async (p: string) => existing.includes(p))
    const listOutside = vi.fn(async (_root: string) => [{ path: path.resolve('py', 'python3.cmd'), version: '3.9' }, { path: outside, version: '3.11.4' }])
    return { exists, listOutside, lookup: createInterpreterLookup({ exists, listOutside, platform: process.platform }) }
  }

  it('never runs a project interpreter: an allowed venv is only checked to exist, the search skips the project', async () => {
    const r = rig()
    expect(await r.lookup(A, languageServersOf({ python: { venvProjects: [A] } }))).toBe(venv)
    expect(r.listOutside).not.toHaveBeenCalled()
    expect(await r.lookup(A, languageServersOf(undefined))).toBe(outside)
    expect(r.listOutside).toHaveBeenCalledWith(A)
    // Not allowed: the venv is not even looked at
    expect(r.exists.mock.calls.filter((c) => c[0] === venv)).toHaveLength(1)
  })

  it('takes the person’s own interpreter before the one found, and none while Python is off', async () => {
    const own = path.resolve('mine', 'python.exe')
    const r = rig()
    expect(await r.lookup(A, languageServersOf({ python: { interpreter: own } }))).toBe(own)
    expect(await r.lookup(A, languageServersOf({ python: { enabled: false } }))).toBeNull()
    expect(await rig([]).lookup(A, languageServersOf({ python: { venvProjects: [A] } }))).toBe(outside)
  })

  it('names the venv found in a project by looking, never by running it', async () => {
    const r = rig()
    expect(await venvInterpreterFor(A, r.exists, process.platform)).toBe(venv)
    expect(await venvInterpreterFor(A, rig([]).exists, process.platform)).toBeNull()
  })
})
