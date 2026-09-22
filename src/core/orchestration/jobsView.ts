// Which of the Jobs sidebar's four screens to draw. Renderer-safe on purpose — no `node:` import, so
// `JobsView.tsx` can import it (unlike `view.ts`, whose header says why that one is main-side only).
//
// **This is one `if` chain lifted out of the component because its order was a defect nothing could
// see** (ruling F41). The Host gate used to arrive as a field on `OrchSnapshot`, and with no project
// open the renderer substitutes a synthetic snapshot of its own — so the gate was dropped on the
// floor and a person with four dead features read "no project is open". Ordering matters here and the
// renderer has no test environment (vitest runs `environment: 'node'`), so the order lives where a
// test can hold it.
import type { OrchHostGate, OrchSnapshot } from '../types'

/** `host` — the Host gate's own screen. `blank` — nothing is known yet, so nothing is drawn (drawing
 *  the empty state here flashes "no jobs" for a frame on every project switch). `empty` — a real
 *  answer of no Runs. `runs` — the list. */
export type JobsViewScreen = 'host' | 'blank' | 'empty' | 'runs'

/**
 * **The gate wins over every snapshot, including the ones that are not really snapshots.** That is
 * the rule F41 asked for: `null` (the reply has not landed), the renderer's synthetic
 * `{ runs: [], projectFolderBusy: false }` for "no project open", and a folded one alike. The two can
 * only disagree while orchestration is down, and then the gate is the only one of the two that knows
 * why — the snapshot is empty either way and says nothing.
 */
export function jobsViewScreen(a: {
  hostGate: OrchHostGate | null
  snapshot: OrchSnapshot | null
}): JobsViewScreen {
  if (a.hostGate) return 'host'
  if (a.snapshot === null) return 'blank'
  return a.snapshot.runs.length === 0 ? 'empty' : 'runs'
}
