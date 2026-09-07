// Which screenshots to delete. The store under userData/preview/shots grows by one PNG per click and
// nothing else ever removes a file, so main applies this after every save and once at startup.
// node: no imports.

export const SHOT_LIMITS = { maxFiles: 200, maxAgeMs: 7 * 24 * 60 * 60 * 1000 } as const

/** Everything older than maxAgeMs, then the oldest of what remains beyond maxFiles. Oldest first,
 *  no duplicates. */
export function evictionPlan(
  files: readonly { path: string; mtimeMs: number }[],
  now: number,
  limits: { maxFiles: number; maxAgeMs: number } = SHOT_LIMITS
): string[] {
  const byAgeDesc = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
  const out: string[] = []
  const kept: typeof byAgeDesc = []
  for (const f of byAgeDesc) {
    if (now - f.mtimeMs > limits.maxAgeMs) out.push(f.path)
    else kept.push(f)
  }
  const excess = kept.length - limits.maxFiles
  for (let i = 0; i < excess; i += 1) out.push(kept[i].path)
  return out
}
