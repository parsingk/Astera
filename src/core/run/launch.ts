// What ▶ means when a configuration is not alone: before-launch tasks, and a compound's members.
// Everything here is pure, so the rules that decide what runs and in what order — and every way that
// can be wrong — are tested directly, while main only executes what this returns.
import type { RunConfig } from './types'

export interface LaunchStep {
  configId: string
  /** configIds that must exit 0 before this step starts. Empty means it starts immediately. */
  after: string[]
}

export type LaunchPlan =
  | { ok: true; steps: LaunchStep[]; focusId: string }
  /** The configuration ids that loop, in the order they were entered. */
  | { ok: false; reason: 'CYCLE'; path: string[] }
  /** `id` is the reference that resolves to nothing; `heldBy` is the configuration holding it — an id
   *  is not something a message can show a user, and the holder is the row they have to go fix.
   *  `heldBy` is null when `rootId` itself is what resolves to nothing. */
  | { ok: false; reason: 'MISSING'; id: string; heldBy: string | null }

/** Thrown internally so a failure deep in the recursion does not need a result type at every level.
 *  Never escapes planLaunch. */
class PlanFailure {
  constructor(readonly plan: Extract<LaunchPlan, { ok: false }>) {}
}

/** The plan for pressing ▶ on `rootId`, against the project's merged configuration list.
 *
 *  Steps come back topologically sorted, so a caller can build each step's promises in one forward
 *  pass and always find its dependencies' promises already made. */
export function planLaunch(configs: readonly RunConfig[], rootId: string): LaunchPlan {
  const byId = new Map(configs.map((c) => [c.id, c]))
  const steps = new Map<string, string[]>()

  const look = (id: string, heldBy: string | null): RunConfig => {
    const c = byId.get(id)
    if (!c) throw new PlanFailure({ ok: false, reason: 'MISSING', id, heldBy })
    return c
  }

  /** Returns the step ids that mean "this configuration has finished". `inheritedAfter` is what a
   *  compound hands down to its members: its own before-launch tasks gate every one of them. */
  const expand = (id: string, inheritedAfter: string[], path: string[], heldBy: string | null): string[] => {
    if (path.includes(id)) throw new PlanFailure({ ok: false, reason: 'CYCLE', path: [...path, id] })
    const c = look(id, heldBy)
    const nextPath = [...path, id]
    const after = [...inheritedAfter]
    // Sequential, not independent: each before-launch task waits on the ones listed ahead of it, so
    // it is `after` (already carrying what earlier entries added) that gets passed down here, not the
    // static `inheritedAfter`. Deduped first: a hand-edited list can hold the same id twice, and
    // without this the second visit would inherit the first visit's own id back as its dependency —
    // a self-loop `topoSort` reports as CYCLE, for a graph that has none.
    for (const b of dedupe(c.beforeLaunch ?? [])) after.push(...expand(b, after, nextPath, id))
    if (c.type === 'compound') {
      // No step of its own: a compound is not a run, it is ▶ pressed on each member. Deduped for the
      // same reason as beforeLaunch above, and because a configuration runs at most once per launch.
      const done: string[] = []
      for (const m of dedupe(c.members)) done.push(...expand(m, after, nextPath, id))
      return done
    }
    // One step per configuration, however many times it is reached. Unioning the two `after` lists is
    // what makes a task named by two members run once, with both members waiting on it.
    const existing = steps.get(id)
    if (existing) for (const a of after) { if (!existing.includes(a)) existing.push(a) }
    else steps.set(id, dedupe(after))
    return [id]
  }

  let done: string[]
  try {
    done = expand(rootId, [], [], null)
  } catch (e) {
    if (e instanceof PlanFailure) return e.plan
    throw e
  }

  const sorted = topoSort(steps)
  // The path check above catches a cycle in the configuration graph. The `after` union can still
  // produce one between steps where the configurations have none — two compounds each naming the
  // other's member as their own before-launch task. Left undetected, the executor's promises wait on
  // each other and the app looks hung with nothing said.
  if (!sorted.ok) return { ok: false, reason: 'CYCLE', path: sorted.path }

  return {
    ok: true,
    steps: sorted.order.map((configId) => ({ configId, after: steps.get(configId) ?? [] })),
    // The run the console should show: the root itself for an ordinary configuration, its first
    // member for a compound. `done` is exactly "what finishing the root means", so this falls out.
    focusId: done[0] ?? rootId
  }
}

const dedupe = (ids: string[]): string[] => [...new Set(ids)]

type TopoResult = { ok: true; order: string[] } | { ok: false; path: string[] }

/** Kahn's algorithm over the step map, one node at a time rather than by whole ready-layer, so that
 *  among several steps that are simultaneously ready the one declared first still comes out first.
 *  On failure, `path` names only the steps still unresolved when no more progress could be made —
 *  not every step in the plan, so an unrelated task swept into the same launch is never blamed. */
function topoSort(steps: ReadonlyMap<string, string[]>): TopoResult {
  const remaining = new Map([...steps].map(([id, after]) => [id, after.filter((a) => steps.has(a))]))
  const out: string[] = []
  while (remaining.size > 0) {
    const next = [...remaining].find(([, after]) => after.every((a) => out.includes(a)))
    if (!next) return { ok: false, path: [...remaining.keys()] }
    out.push(next[0])
    remaining.delete(next[0])
  }
  return { ok: true, order: out }
}

/** The configurations that may be added to `hostId`'s before-launch list, or to a compound's members:
 *  every other configuration, minus the ones already listed and the ones that would create a cycle.
 *  Called with the dialog's draft list, not the stored one — a configuration added with ＋ a moment
 *  ago is a valid target.
 *
 *  Candidate counts are in the tens, so planning once per candidate is not worth optimising away. */
export function addableTargets(
  configs: readonly RunConfig[],
  hostId: string,
  current: readonly string[]
): RunConfig[] {
  const host = configs.find((c) => c.id === hostId)
  if (!host) return []
  const taken = new Set(current)
  return configs.filter((c) => {
    if (c.id === hostId || taken.has(c.id)) return false
    const probe = configs.map((x) => (x.id === hostId ? withRef(host, current, c.id) : x))
    return planLaunch(probe, hostId).ok
  })
}

/** `host` with its draft list `current` plus one more reference — a member for a compound, a
 *  before-launch task for anything else. Built from `current`, not from `host`'s own stored field:
 *  the draft can hold a reference not yet applied, and dropping it here would let a candidate that
 *  only closes a cycle together with that reference through. Only ever handed to planLaunch, never
 *  stored. */
function withRef(host: RunConfig, current: readonly string[], id: string): RunConfig {
  if (host.type === 'compound') return { ...host, members: [...current, id] }
  return { ...host, beforeLaunch: [...current, id] }
}
