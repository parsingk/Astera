import { describe, it, expect } from 'vitest'
import { createWorktreeRoute } from './worktreeRoute'
import type { WorktreeWriter } from '../../core/worktrees/registry'

const fakeRegistry = () => {
  const r = {
    writer: null as WorktreeWriter | null,
    accepted: [] as unknown[],
    loads: 0,
    writeThrough(w: WorktreeWriter | null) {
      r.writer = w
    },
    accept(f: unknown) {
      r.accepted.push(f)
      return true
    },
    async load() {
      r.loads += 1
      return { recovered: false }
    }
  }
  return r
}
const on = { connected: true, unresponsive: false, features: ['spawn', 'worktrees'] }

it('routes writes to the Host once it announces worktrees, and fills from worktree-list', async () => {
  const reg = fakeRegistry()
  const calls: Array<{ cmd: string; args: unknown }> = []
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async (m) => {
      calls.push(m)
      return { status: 200, body: { seq: 1, file: { items: [] } } }
    }
  })
  await route.status(on)
  expect(calls.map((c) => c.cmd)).toEqual(['worktree-list'])
  expect(reg.accepted).toEqual([{ items: [] }])
  await reg.writer!.add({ id: 'a' } as never)
  expect(calls.at(-1)).toMatchObject({ cmd: 'worktree-add', args: { info: { id: 'a' } } })
})

it('a Host refusal reaches the caller as an error', async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async (m) => (m.cmd === 'worktree-list' ? { status: 200, body: { seq: 1, file: { items: [] } } } : { status: 403, body: { error: 'no' } })
  })
  await route.status(on)
  await expect(reg.writer!.removeEntry('a')).rejects.toThrow(/no/)
})

it('goes back to the file, re-read, when the Host goes, is unresponsive or does not own worktrees', async () => {
  for (const off of [{ connected: false, features: [] }, { ...on, unresponsive: true }, { connected: true, features: ['spawn'] }]) {
    const reg = fakeRegistry()
    const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => ({ status: 200, body: { seq: 1, file: { items: [] } } }) })
    await route.status(on)
    await route.status(off)
    expect(reg.writer).toBeNull()
    expect(reg.loads).toBe(1)
  }
})

it('does nothing for a status that does not change the route, and refills on every new handshake', async () => {
  const reg = fakeRegistry()
  let lists = 0
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async () => {
      lists += 1
      return { status: 200, body: { seq: 1, file: { items: [] } } }
    }
  })
  await route.status(on)
  await route.status(on)
  expect(lists).toBe(1)
  await route.status({ connected: false, features: [] })
  await route.status(on)
  expect(lists).toBe(2)
})

it('takes a worktrees-state push only while the Host owns the file', async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => ({ status: 200, body: { seq: 1, file: { items: [] } } }) })
  route.pushed({ t: 'worktrees-state', seq: 1, file: { items: [] } })
  expect(reg.accepted).toEqual([])
  await route.status(on)
  route.pushed({ t: 'worktrees-state', seq: 2, file: { root: 'D:/r', items: [] } })
  expect(reg.accepted.at(-1)).toEqual({ root: 'D:/r', items: [] })
})

// seq (WorktreesSnapshot's contract, protocol.ts): a push or a reply older than the last one applied
// is ignored, a refill resets the counter to its own fill's value (a new Host life is never judged by
// an old one's numbers), and a write reply's snapshot is applied by the same rule as a push.
it('ignores a stale push', async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async () => ({ status: 200, body: { seq: 5, file: { items: [] } } })
  })
  await route.status(on) // the refill lands at seq 5
  route.pushed({ t: 'worktrees-state', seq: 4, file: { root: 'stale', items: [] } })
  expect(reg.accepted.at(-1)).toEqual({ items: [] }) // the refill's file, not the stale push's
})

it('applies a lower seq after a refill, which is what a new Host life looks like', async () => {
  const reg = fakeRegistry()
  let seq = 100
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async () => ({ status: 200, body: { seq, file: { items: [] } } })
  })
  await route.status(on) // an old Host life: lastSeq lands at 100
  await route.status({ connected: false, features: [] }) // back to local — the seq is forgotten
  seq = 1 // a new Host life starts its own counter back at the bottom
  await route.status(on) // the refill takes this fill's seq, whatever the dead Host's numbers were
  route.pushed({ t: 'worktrees-state', seq: 2, file: { root: 'new-life', items: [] } })
  expect(reg.accepted.at(-1)).toEqual({ root: 'new-life', items: [] })
})

it("applies a write reply's snapshot", async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async (m) =>
      m.cmd === 'worktree-list'
        ? { status: 200, body: { seq: 1, file: { items: [] } } }
        : { status: 200, body: { seq: 2, file: { root: 'added', items: [{ id: 'a' }] } } }
  })
  await route.status(on)
  await reg.writer!.add({ id: 'a' } as never)
  expect(reg.accepted.at(-1)).toEqual({ root: 'added', items: [{ id: 'a' }] })
})
