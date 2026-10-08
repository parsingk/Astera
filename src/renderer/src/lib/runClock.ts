// The clock a Run card is drawn with (audit UI-11): the live one when a task of it runs or waits (its elapsed time and
// its countdown move), a fixed one otherwise, so a finished card is not drawn again on every tick of the sidebar.

export function clockFor(run: { tasks: ReadonlyArray<{ startedAt?: string; waiting?: unknown }> }, nowMs: number): number {
  return run.tasks.some((t) => t.startedAt || t.waiting) ? nowMs : 0
}
