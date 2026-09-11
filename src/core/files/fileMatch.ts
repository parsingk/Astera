/**
 * Which of `paths` the text after an `@` is asking for, best first.
 *
 * Four tiers, and the order is the whole point: Enter takes the first row, so what a person means by
 * typing `conv` has to be the file called that, not the first of forty files that merely live under a
 * folder with those letters in it.
 *
 *   1. the name with its last extension removed IS it     fileMatch.ts for `fileMatch`
 *   2. the file's own name starts with it                  conversation.ts for `conv`
 *   3. the file's own name contains it                     codexConversation.ts for `conv`
 *   4. the path contains it                                src/core/conv/other.ts for `conv`
 *
 * The first tier exists because `fileMatch.test.ts` also starts with `fileMatch` and sorts ahead of
 * it, so without it the exact thing someone typed is not what Enter takes.
 *
 * Within a tier the caller's order is kept, which is the walk's own: shallower paths first. An empty
 * query asks for everything, which is what a bare `@` means.
 *
 * Matching is case-insensitive and on plain substrings, not a fuzzy score. A fuzzy match earns its
 * keep when the list is long and the query is short, and it costs the person the ability to predict
 * what they will get; these lists are already narrowed by a project root and a cap.
 */
export function filterFilePaths(
  paths: readonly string[],
  query: string,
  limit: number
): string[] {
  const needle = query.toLowerCase()
  if (needle === '') return paths.slice(0, limit)

  const exact: string[] = []
  const nameStarts: string[] = []
  const nameContains: string[] = []
  const pathContains: string[] = []
  for (const p of paths) {
    const lower = p.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const stem = dot === -1 ? name : name.slice(0, dot)
    if (stem === needle) exact.push(p)
    else if (name.startsWith(needle)) nameStarts.push(p)
    else if (name.includes(needle)) nameContains.push(p)
    else if (lower.includes(needle)) pathContains.push(p)
    // The cap is checked against the best tier only once it alone can fill the answer, so a query
    // with thousands of weak matches still cannot make this walk them all into an array.
    if (exact.length >= limit) break
  }
  return [...exact, ...nameStarts, ...nameContains, ...pathContains].slice(0, limit)
}

/**
 * The `@…` being typed at the caret, or null when there is none.
 *
 * A file reference starts a word: at the very beginning, or after whitespace. Anywhere else an `@` is
 * an email address or a handle, and opening a file list over someone's address would be wrong. Only
 * the text before the caret counts, so editing the middle of a line offers what is being edited
 * rather than whatever follows it.
 */
export function fileTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}
