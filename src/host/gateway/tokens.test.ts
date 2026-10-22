// Agent Control Plane release 2 (Gateway design §4.3): a session's Gateway token is registered when the Host opens its
// pty or chat proc and forgotten when that ends; nothing else makes a token live.
import { describe, it, expect } from 'vitest'
import { PtyRegistry, type RegistryPty } from '../registry'
import { ProcRegistry, type RegistryProc } from '../procRegistry'
import { createTokenTable, watchGatewayTokens } from './tokens'

const TOKEN = 'A'.repeat(43)

function rig(failSpawn = false) {
  const ptyExit: ((e: { exitCode: number }) => void)[] = []
  const procExit: ((e: { exitCode: number }) => void)[] = []
  const ptys = new PtyRegistry({
    spawn: () => {
      if (failSpawn) throw new Error('no pty')
      return { pid: 1, onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => ptyExit.push(cb), write() {}, resize() {}, kill() {}, pause() {}, resume() {} } as unknown as RegistryPty
    },
    log: () => {}
  })
  const procs = new ProcRegistry({
    spawn: () =>
      ({ pid: 2, onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => procExit.push(cb), write() {}, kill() {} }) as unknown as RegistryProc,
    log: () => {}
  })
  const table = createTokenTable()
  const forgotten: string[][] = []
  watchGatewayTokens({ ptys, procs, table, onForget: (t) => forgotten.push(t) })
  const env = (token = TOKEN) => ({ PATH: 'x', ASTERA_GATEWAY_TOKEN: token, ASTERA_GATEWAY_GRANT: 'mcp-linear,mcp-files' })
  return { ptys, procs, table, forgotten, env, ptyExit, procExit }
}

describe('gateway session tokens', () => {
  it('registers a pty opened with a token, with its folder and grant, and forgets it when the pty exits', () => {
    const h = rig()
    expect(h.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: h.env() } }).ok).toBe(true)
    const b = h.table.lookup(TOKEN)
    expect(b).toMatchObject({ ownerId: 'p1', folder: 'D:/repo' })
    expect([...b!.grant]).toEqual(['mcp-linear', 'mcp-files'])
    h.ptyExit[0]({ exitCode: 0 })
    expect(h.table.lookup(TOKEN)).toBeNull()
    expect(h.forgotten).toEqual([[TOKEN]])
  })

  it('does the same for a chat proc', () => {
    const h = rig()
    expect(h.procs.open({ id: 'c1', file: 'codex', args: ['app-server'], opts: { cwd: 'D:/repo', env: h.env() } }).ok).toBe(true)
    expect(h.table.lookup(TOKEN)?.ownerId).toBe('c1')
    h.procExit[0]({ exitCode: 1 })
    expect(h.table.lookup(TOKEN)).toBeNull()
  })

  it('registers nothing for an open with no token, or one that failed', () => {
    const plain = rig()
    plain.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: { PATH: 'x' } } })
    expect(plain.table.owners()).toBe(0)
    const failing = rig(true)
    expect(failing.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: failing.env() } }).ok).toBe(false)
    expect(failing.table.lookup(TOKEN)).toBeNull()
  })

  it('answers null for a token of another length or one character off', () => {
    const h = rig()
    h.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: h.env() } })
    expect(h.table.lookup(TOKEN.slice(1))).toBeNull()
    expect(h.table.lookup('B' + TOKEN.slice(1))).toBeNull()
    expect(h.table.lookup('')).toBeNull()
  })
})
