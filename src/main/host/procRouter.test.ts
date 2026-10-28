import { describe, it, expect } from 'vitest'
import { createProcRouter } from './procRouter'
import type { ProcFactory, ProcLike } from '../../core/sessions/proc'

const proc = (tag: string): ProcLike & { tag: string } => ({ tag, pid: 1, onLine: () => {}, onExit: () => {}, write: () => {}, kill: () => {} })

describe('createProcRouter', () => {
  it('drops the workload token and grant from a spawn that falls back, and keeps them for the Host', () => {
    const seen: Array<Record<string, string | undefined>> = []
    const capture: ProcFactory = (_f, _a, o) => (seen.push(o.env), proc('x'))
    const r = createProcRouter(capture)
    const env = { PATH: 'x', ASTERA_SESSION: 's', ASTERA_GATEWAY_TOKEN: 'T', ASTERA_GATEWAY_GRANT: 'g', ASTERA_LOOPBACK: 'http://127.0.0.1:1' }
    r.factory('codex', [], { cwd: 'D:/p', env })
    r.use(capture)
    r.factory('codex', [], { cwd: 'D:/p', env })
    expect(seen[0]).toEqual({ PATH: 'x', ASTERA_SESSION: 's' })
    expect(seen[1]).toEqual(env)
  })
  it('uses the fallback until told otherwise, stamping outlivesApp false', () => {
    const fallback: ProcFactory = () => proc('fallback')
    const r = createProcRouter(fallback)
    const p = r.factory('codex', [], { cwd: 'D:/p', env: {} }) as ProcLike & { tag: string }
    expect(p.tag).toBe('fallback')
    expect(p.outlivesApp).toBe(false)
  })
  it('routes to the current factory once set, stamping outlivesApp true, and back on null', () => {
    const r = createProcRouter(() => proc('fallback'))
    r.use(() => proc('host'))
    const p = r.factory('codex', [], { cwd: 'D:/p', env: {} }) as ProcLike & { tag: string }
    expect(p.tag).toBe('host')
    expect(p.outlivesApp).toBe(true)
    r.use(null)
    expect((r.factory('codex', [], { cwd: 'D:/p', env: {} }) as ProcLike & { tag: string }).tag).toBe('fallback')
  })
})
