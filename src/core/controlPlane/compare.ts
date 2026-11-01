// This computer's extensions against a Runtime's kept snapshot (remote governance design §6.1, §6.2). Renderer-safe:
// type imports only, so the Host's findings and the Settings detail compare the same way.
import type { ExtensionKind } from '../extensions/types'
import type { ControlPlaneReport, ReportExtension } from './report'

export type ComparisonState = 'missing' | 'different' | 'off' | 'secret-missing' | 'same'
export interface ComparisonRow {
  id: string
  kind: ExtensionKind
  name: string
  expected: boolean
  here: ReportExtension | null
  there: ReportExtension | null
  /** Judged only for an expected row with a snapshot; null otherwise (an entry only there, or not expected). */
  state: ComparisonState | null
}

// A record rather than a list, so tsc flags a kind added to the union and not here.
const KIND_ORDER: Record<ExtensionKind, number> = { mcp: 0, skill: 1, command: 2, agent: 3 }

/** §6.1: an expected id this computer no longer has drops out when read, as removed accounts drop out of a profile. */
export function liveExpected(expected: readonly string[] | undefined, local: readonly ReportExtension[]): string[] {
  const here = new Set(local.map((e) => e.id))
  return (expected ?? []).filter((id) => here.has(id))
}

/** One state per row, the first that holds in the order missing, different, off, secret missing (§6.2). */
function judge(here: ReportExtension, there: ReportExtension | undefined): ComparisonState {
  if (!there) return 'missing'
  // A copy that could not be read has no hash and makes no claim about its content, so it is never "different"
  // (planning ruling 10). An MCP server carries no hash at all.
  if (here.compareHash !== undefined && there.compareHash !== undefined && here.compareHash !== there.compareHash) return 'different'
  // Ruling R11-1: an entry disabled here is given to no provider here, so nothing there can be "off" against it.
  if (here.enabled && (!there.enabled || here.providers.some((p) => !there.providers.includes(p)))) return 'off'
  const thereNames = there.secretNames ?? []
  if (here.kind === 'mcp' && (here.secretNames ?? []).some((n) => !thereNames.includes(n))) return 'secret-missing'
  return 'same'
}

/** A row per entry here and per entry only there. `report.extensions` null (the Runtime could not read its registry,
 *  ruling R9-3) compares as no snapshot: no entry there is known, so nothing is judged missing. */
export function compareExtensions(a: {
  local: readonly ReportExtension[]
  report: ControlPlaneReport | null
  expected: readonly string[] | undefined
}): ComparisonRow[] {
  const thereList = a.report?.extensions ?? null
  const there = new Map((thereList ?? []).map((e) => [e.id, e]))
  const expected = new Set(a.expected ?? [])
  const rows: ComparisonRow[] = a.local.map((here) => {
    const isExpected = expected.has(here.id)
    return {
      id: here.id,
      kind: here.kind,
      name: here.name,
      expected: isExpected,
      here,
      there: there.get(here.id) ?? null,
      state: isExpected && thereList ? judge(here, there.get(here.id)) : null
    }
  })
  const hereIds = new Set(a.local.map((e) => e.id))
  for (const e of thereList ?? []) {
    // An id only there is never expected: the expected list names this computer's entries (§6.1).
    if (!hereIds.has(e.id)) rows.push({ id: e.id, kind: e.kind, name: e.name, expected: false, here: null, there: e, state: null })
  }
  // A fixed locale, so the Host's findings and the detail list in the same order on every machine.
  return rows.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name, 'en') || x.id.localeCompare(y.id, 'en'))
}
