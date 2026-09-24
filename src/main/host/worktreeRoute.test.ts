import { it, expect } from 'vitest'
import { createWorktreeRoute } from './worktreeRoute'
import type { WorktreeWriter } from '../../core/worktrees/registry'

const fakeRegistry = () => {
  const r = {
    writer: null as WorktreeWriter | null,
    accepted: [] as unknown[],
    refreshes: 0,
    writeThrough(w: WorktreeWriter | null) {
      r.writer = w
    },
    accept(f: unknown) {
      r.accepted.push(f)
      return true
    },
    async refresh() {
      r.refreshes += 1
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
    expect(reg.refreshes).toBe(1)
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

// I3, fix round 1: refresh(), not load(), is what returning to local re-reads with. A rejection is
// caught and logged, not left to break the caller's status() chain — the route is still local either
// way, and the next write (or the next refill) is what actually needs the file to be right.
it('a refresh that rejects still leaves the route local, and logs the error', async () => {
  const reg = fakeRegistry()
  reg.refresh = async () => {
    throw new Error('boom')
  }
  const logs: string[] = []
  const route = createWorktreeRoute({ registry: reg, log: (m) => logs.push(m), call: async () => ({ status: 200, body: { seq: 1, file: { items: [] } } }) })
  await route.status(on)
  await route.status({ connected: false, features: [] })
  expect(reg.writer).toBeNull()
  expect(logs.some((m) => m.includes('boom'))).toBe(true)
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

// I2, fix round 1: a `worktrees-state` push (seq S+1) can land, and be applied, while a `worktree-list`
// reply (seq S) is already in flight — the reply's `await` continuation only resumes in a microtask,
// after every line already in the socket's buffer (including that push) has run synchronously. The
// fill must not then roll `lastSeq` back to S and apply the older file over the push's newer one.
it('does not let the worktree-list fill roll back a push that arrived first', async () => {
  const reg = fakeRegistry()
  let resolveList: (v: { status: number; body: unknown }) => void = () => {}
  const listPromise = new Promise<{ status: number; body: unknown }>((res) => {
    resolveList = res
  })
  const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => listPromise })
  const statusPromise = route.status(on) // the list request is sent; mode is already 'host'
  route.pushed({ t: 'worktrees-state', seq: 6, file: { root: 'six', items: [] } }) // arrives first
  resolveList({ status: 200, body: { seq: 5, file: { root: 'five', items: [] } } }) // the fill, older
  await statusPromise
  expect(reg.accepted.at(-1)).toEqual({ root: 'six', items: [] })
})

// M6 (missing route tests): a list still in flight when the route leaves the Host must not have its
// reply overwrite whatever `refresh()` re-read from disk on the way back to local — the same hazard
// I3 fixes for `load()`, but for a stale reply rather than a stale in-memory value.
it('a list in flight when status(off) arrives does not overwrite what refresh() just re-read', async () => {
  const reg = fakeRegistry()
  let resolveList: (v: { status: number; body: unknown }) => void = () => {}
  const listPromise = new Promise<{ status: number; body: unknown }>((res) => {
    resolveList = res
  })
  const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => listPromise })
  const statusPromise = route.status(on) // the list request is sent; mode is already 'host'
  await route.status({ connected: false, features: [] }) // the Host goes; refresh() runs, mode is 'local'
  resolveList({ status: 200, body: { seq: 1, file: { root: 'stale-host-file', items: [] } } })
  await statusPromise
  expect(reg.accepted).toEqual([]) // the abandoned list's reply was never applied
  expect(reg.refreshes).toBe(1)
})

// M6: a refused list (rather than one that throws) leaves the route on host, exactly as a throwing one
// does — the next push still fills the mirror.
it('a failed list keeps the route on host, and a later push fills it', async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => ({ status: 500, body: { error: 'boom' } }) })
  await route.status(on)
  expect(reg.writer).not.toBeNull() // still routed to the Host
  route.pushed({ t: 'worktrees-state', seq: 1, file: { root: 'later', items: [] } })
  expect(reg.accepted.at(-1)).toEqual({ root: 'later', items: [] })
})

// M6: a write reply older than what this connection already applied is ignored for the mirror, same
// as a push would be — but the caller still gets the file the Host actually wrote back, because the
// write itself happened regardless of what order the replies come back in.
it('a stale write reply is ignored for the mirror, though the caller still gets the file back', async () => {
  const reg = fakeRegistry()
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async (m) =>
      m.cmd === 'worktree-list'
        ? { status: 200, body: { seq: 5, file: { items: [] } } }
        : { status: 200, body: { seq: 3, file: { root: 'stale-write', items: [] } } }
  })
  await route.status(on) // lastSeq lands at 5
  const file = await reg.writer!.add({ id: 'a' } as never)
  expect(reg.accepted.at(-1)).toEqual({ items: [] }) // the refill's file, not the stale write reply's
  expect(file).toEqual({ root: 'stale-write', items: [] }) // the caller still gets what the Host said
})

// M3: `accept` can refuse a file as malformed. That must not move `lastSeq` past it — a later, good
// file at a lower seq is still the first good one this connection has seen and must still be taken.
it('a malformed push does not advance lastSeq — a later, lower one is still taken', async () => {
  const reg = fakeRegistry()
  let calls = 0
  reg.accept = (f: unknown) => {
    calls += 1
    if (calls === 1) return false
    reg.accepted.push(f)
    return true
  }
  const route = createWorktreeRoute({ registry: reg, log: () => {}, call: async () => ({ status: 500, body: { error: 'no refill here' } }) })
  await route.status(on) // mode becomes 'host'; the refused refill never touches accept()
  route.pushed({ t: 'worktrees-state', seq: 5, file: { root: 'malformed', items: [] } }) // accept() refuses it
  route.pushed({ t: 'worktrees-state', seq: 3, file: { root: 'good', items: [] } }) // not "< null"
  expect(reg.accepted).toEqual([{ root: 'good', items: [] }])
})

// M3: a write already in flight to the Host when the route falls back to local must not have its
// reply, arriving later, overwrite what refresh() already re-read from disk.
it('a write reply that lands after the route has gone back to local is not applied', async () => {
  const reg = fakeRegistry()
  let resolveWrite: (v: { status: number; body: unknown }) => void = () => {}
  const writePromise = new Promise<{ status: number; body: unknown }>((res) => {
    resolveWrite = res
  })
  const route = createWorktreeRoute({
    registry: reg,
    log: () => {},
    call: async (m) => (m.cmd === 'worktree-list' ? { status: 200, body: { seq: 1, file: { items: [] } } } : writePromise)
  })
  await route.status(on)
  const addPromise = reg.writer!.add({ id: 'a' } as never) // the write is now in flight to the Host
  await route.status({ connected: false, features: [] }) // the route goes back to local and refresh()es
  resolveWrite({ status: 200, body: { seq: 2, file: { root: 'late-write', items: [] } } })
  await addPromise
  expect(reg.accepted.at(-1)).toEqual({ items: [] }) // the refill's file — the late write reply never landed
})
