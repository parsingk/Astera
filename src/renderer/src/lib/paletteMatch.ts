// The command palette's order. Ordered substring tiers, the rule core/files/fileMatch.ts argues for: Enter takes
// the first row, so what a person types has to land on the action they can predict, not on the best fuzzy score
// (knowledge/decisions/ADR-007).
//
//   1. the title starts with it          "Run" for `run`
//   2. a word of the title starts with it "Rerun the selected run" for `run`, "Kubernetes 패널 열기/닫기" for `닫기`
//   3. the title contains it             "Toggle the Jobs sidebar" for `ob`
//   4. the action id contains it         `explorer.toggleMode` for `togglemode`, whatever language the title is in
//
// Within a tier, recent actions come first (most recent first), then the list's own order. A recent action never
// jumps a better tier. An empty query lists everything the same way.

const WORD_SPLIT = /[\s/·()\-,]+/

export function rankActions<T extends { id: string; title: string }>(
  rows: readonly T[],
  query: string,
  recent: readonly string[]
): T[] {
  const needle = query.trim().toLowerCase()
  const tiers: T[][] = [[], [], [], []]
  for (const row of rows) {
    const title = row.title.toLowerCase()
    let tier: number
    if (needle === '' || title.startsWith(needle)) tier = 0
    else if (title.split(WORD_SPLIT).some((w) => w.startsWith(needle))) tier = 1
    else if (title.includes(needle)) tier = 2
    else if (row.id.toLowerCase().includes(needle)) tier = 3
    else continue
    tiers[tier].push(row)
  }
  const rank = (id: string): number => {
    const at = recent.indexOf(id)
    return at < 0 ? recent.length : at
  }
  // Array.prototype.sort is stable, so rows with the same rank keep the list's order.
  return tiers.flatMap((tier) => tier.slice().sort((a, b) => rank(a.id) - rank(b.id)))
}
