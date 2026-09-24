import { it, expect } from 'vitest'
import path from 'node:path'
import { createWorktreeRoute } from './worktreeRoute'
import { WorktreeRegistry, type WorktreeWriter } from '../../core/worktrees/registry'
import { tempDir } from '../../core/worktrees/testRepo'
import type { WorktreeInfo } from '../../core/types'

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
const wt = (id: string): WorktreeInfo => ({
  id, repoPath: 'D:/r', path: `D:/wt/${id}`, name: id, branch: `u/${id}`, baseRef: 'main', createdAt: '2026-09-24T00:00:00.000Z'
})
/** A real registry against a temp profile folder, for the two tests (final review m3) that need the
 *  registry's own `add`/`removeEntry`/`setRoot` — not the fake, which only ever recorded what `accept()`
 *  was called with and so could not show what `adopt()` (registry.ts) does with a write reply. */
const realRegistry = async (): Promise<WorktreeRegistry> => {
  const dir = await tempDir('astera-wtroute-')
  const r = new WorktreeRegistry(path.join(dir, 'worktrees.json'), 'D:/root')
  await r.load()
  return r
}

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

// M6, corrected by the final review's m3: the fake only ever recorded what `accept()` was called
// with, which made this read as protection the mirror actually gets. Driven through a real
// WorktreeRegistry, `add`/`removeEntry`/`setRoot` hold whatever the writer answered unconditionally
// (each calls private `adopt` on what its writer answered) — the seq check inside `write()` only decides whether
// `takeIfNewer`/`accept()` runs (the route's own `lastSeq` bookkeeping and the push-side mirror), not
// whether the registry that made this very call applies its own writer's answer. So a write reply
// older than an already-applied fill still lands on the registry's real state. This cannot happen
// against a real Host — a reply cannot be older than a fill that already landed on the same
// connection, in the same Host life — so it costs nothing in production; the queue and the socket's
// own ordering are what actually protect the registry here, not this guard. This test pins what the
// registry really ends up holding, and that the route's own bookkeeping (`lastSeq`) is untouched by it.
it('a stale write reply still lands on the registry, though it does not move the route’s own lastSeq', async () => {
  const registry = await realRegistry()
  const route = createWorktreeRoute({
    registry,
    log: () => {},
    call: async (m) =>
      m.cmd === 'worktree-list'
        ? { status: 200, body: { seq: 5, file: { items: [] } } }
        : { status: 200, body: { seq: 3, file: { root: 'stale-write', items: [] } } }
  })
  await route.status(on) // lastSeq lands at 5
  await registry.add(wt('a')) // the write reply carries seq 3, older than the fill's 5
  expect(registry.list()).toEqual([]) // adopt() held the reply's file regardless
  expect(registry.getRoot()).toBe('stale-write')
  // lastSeq is still 5: a push at seq 4 (newer than the stale write, older than the fill) is still
  // refused, exactly as it would be had the stale write never been applied.
  route.pushed({ t: 'worktrees-state', seq: 4, file: { root: 'push-4', items: [] } })
  expect(registry.getRoot()).toBe('stale-write')
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

// M3, corrected by the final review's m3: a write already in flight to the Host when the route falls
// back to local must not have its reply, arriving later, overwrite what refresh() already re-read
// from disk. Driven through the fake, this only ever showed that `accept()` was not called for the
// late reply. Driven through a real WorktreeRegistry, the late reply's `adopt()` still runs (the
// registry's own `add`, not gated by the route's `mode` at all) — it is the queue that saves this:
// `registry.add`'s job read the writer before `writeThrough(null)` ran, so it still calls the (by
// then detached) writer, and whatever it adopts is immediately overwritten by the `refresh()` job
// queued right behind it, which is what the app's real fallback depends on (A26). The final state is
// still right; the mechanism that makes it right is the queue, not this guard.
it('a write reply that lands after the route has gone back to local is overwritten by refresh(), not applied on its own', async () => {
  const registry = await realRegistry()
  let releaseWrite!: () => void
  const writeGate = new Promise<void>((res) => (releaseWrite = res))
  let reachedWrite!: () => void
  const atWrite = new Promise<void>((res) => (reachedWrite = res))
  const route = createWorktreeRoute({
    registry,
    log: () => {},
    call: async (m) => {
      if (m.cmd === 'worktree-list') return { status: 200, body: { seq: 1, file: { items: [] } } }
      reachedWrite()
      await writeGate
      return { status: 200, body: { seq: 2, file: { root: 'late-write', items: [] } } }
    }
  })
  await route.status(on)
  const adding = registry.add(wt('a')) // registry.add reads the writer now, while it is still the Host's
  await atWrite // …and has already called it — proven by the mock having been reached
  const statusOff = route.status({ connected: false, features: [] }) // mode/writer flip; refresh() queues behind the add
  releaseWrite() // the late reply resolves: adopt() applies it, then refresh() immediately overwrites it
  await adding
  await statusOff
  expect(registry.list()).toEqual([])
  expect(registry.getRoot()).toBe('D:/root') // the default from disk, not 'late-write'
})
