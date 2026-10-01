// The order and the cut of the list tools (Task 12 U4). Applied after `publicFor`, so it sorts by
// public fields only, and before the list goes under its name in the result.

export const LIST_LIMIT = { min: 1, max: 200, default: 50 } as const

type Row = Record<string, unknown>
const field = (r: unknown, k: string): unknown => (r !== null && typeof r === 'object' ? (r as Row)[k] : undefined)
const text = (r: unknown, k: string): string => {
  const v = field(r, k)
  return typeof v === 'string' ? v : ''
}
const num = (r: unknown, k: string): number => {
  const v = field(r, k)
  return typeof v === 'number' ? v : 0
}

/** How each list tool orders its rows. A tool not here keeps the Host's order: list_tasks (DAG and
 *  creation order), list_projects and list_accounts. Every sort is stable, so ties keep it too. */
const ORDER: Record<string, (a: unknown, b: unknown) => number> = {
  list_jobs: (a, b) => text(b, 'createdAt').localeCompare(text(a, 'createdAt')),
  list_runs: (a, b) => num(b, 'ordinal') - num(a, 'ordinal'),
  list_questions: (a, b) => text(a, 'createdAt').localeCompare(text(b, 'createdAt'))
}

/** The list in its tool's order, cut to `limit`. A cut list says so with `truncated` and `total`;
 *  a whole one carries neither key. */
export function orderAndCut(
  tool: string,
  list: readonly unknown[],
  limit: number
): { list: unknown[]; truncated?: true; total?: number } {
  const order = ORDER[tool]
  const ordered = order ? [...list].sort(order) : [...list]
  return ordered.length > limit ? { list: ordered.slice(0, limit), truncated: true, total: ordered.length } : { list: ordered }
}
