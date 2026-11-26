import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { ClientMessage } from '../../core/host/protocol'
import type { LspProblem } from '../../core/lsp/model'
import { createHostLspView, pickInterpreter } from './hostLsp'
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
// else the one the person picked, else the first found outside the project; never a batch file
describe('pickInterpreter', () => {
  const venv = path.join(A, '.venv', 'Scripts', 'python.exe')
  const outside = path.resolve('py', 'python.exe')
  const found = [{ path: venv, version: '3.12.1' }, { path: path.resolve('py', 'python3.cmd'), version: '3.9' }, { path: outside, version: '3.11.4' }]
  it('uses the project’s venv only when the person allowed it for that project', () => {
    expect(pickInterpreter(A, languageServersOf({ python: { venvProjects: [A] } }), found)).toBe(venv)
    expect(pickInterpreter(A, languageServersOf(undefined), found)).toBe(outside)
  })
  it('takes the person’s own interpreter before the first one found, and none when there is none', () => {
    const own = path.resolve('mine', 'python.exe')
    expect(pickInterpreter(A, languageServersOf({ python: { interpreter: own } }), found)).toBe(own)
    expect(pickInterpreter(A, languageServersOf(undefined), [{ path: venv, version: '3.12' }])).toBeNull()
    expect(pickInterpreter(A, languageServersOf(undefined), [])).toBeNull()
  })
})
