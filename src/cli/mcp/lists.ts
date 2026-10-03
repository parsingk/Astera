// The order, the cut and the paging of the list tools (Task 12 U4, spec §48). Applied after
// `publicFor`, so it sorts by public fields only, and before the list goes under its name in the result.

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
 *  creation order), list_projects, list_accounts and list_run_configs. Every sort is stable, so ties keep it too. */
const ORDER: Record<string, (a: unknown, b: unknown) => number> = {
  list_jobs: (a, b) => text(b, 'createdAt').localeCompare(text(a, 'createdAt')),
  // createdAt, not ordinal: ordinal counts per Job, so across Jobs it would put a young Job's newest
  // Run behind an old Job's old ones and the cut would drop it. Ordinal breaks a tie.
  list_runs: (a, b) => text(b, 'createdAt').localeCompare(text(a, 'createdAt')) || num(b, 'ordinal') - num(a, 'ordinal'),
  list_questions: (a, b) => text(a, 'createdAt').localeCompare(text(b, 'createdAt')),
  // A session's public shape has no timestamp: live ones first, then the Host's registry order
  // (terminals, then chats, each in spawn order).
  list_sessions: (a, b) => Number(field(b, 'alive') === true) - Number(field(a, 'alive') === true)
}

/** The page of the list from `offset`, in its tool's order, cut to `limit` (spec §48). A page that is
 *  not the whole list says so with `truncated` and `total`, and `nextCursor` when more remain after it;
 *  a whole one carries none of the three. The order is applied first, so every page follows it. */
export function orderAndCut(
  tool: string,
  list: readonly unknown[],
  limit: number,
  offset = 0
): { list: unknown[]; truncated?: true; total?: number; nextCursor?: string } {
  const order = ORDER[tool]
  const ordered = order ? [...list].sort(order) : [...list]
  const page = ordered.slice(offset, offset + limit)
  if (page.length === ordered.length) return { list: page }
  const next = offset + limit
  return { list: page, truncated: true, total: ordered.length, ...(next < ordered.length ? { nextCursor: pageCursor(tool, next) } : {}) }
}

/** The opaque cursor for the page of `tool` that starts at `offset`: base64url JSON `{ o, k }`. */
export function pageCursor(tool: string, offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset, k: tool }), 'utf8').toString('base64url')
}

/** The offset a cursor names, or why it cannot be used with `tool`: one from another tool, or one that
 *  is not a cursor at all. */
export function cursorOffset(tool: string, cursor: string): number | { error: string } {
  let v: unknown
  try {
    v = /^[A-Za-z0-9_-]+$/.test(cursor) ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : undefined
  } catch {
    v = undefined
  }
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null
  const malformed = { error: `cursor is not one ${tool} gave; pass the nextCursor of a ${tool} result, or leave it out to start from the first page` }
  if (o === null || typeof o.k !== 'string' || typeof o.o !== 'number' || !Number.isSafeInteger(o.o) || o.o < 0) return malformed
  // Named back only when it is a tool name: the rest of a cursor is the caller's own text.
  if (o.k !== tool)
    return /^list_[a-z_]+$/.test(o.k) ? { error: `cursor is from ${o.k}, not ${tool}; pass the nextCursor of a ${tool} result` } : malformed
  return o.o
}
