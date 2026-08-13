import type { RunConfig, RunConfigType } from './types'

const KNOWN: RunConfigType[] = ['shell', 'npm', 'node', 'gradle', 'maven', 'cargo', 'go']

const isStringMap = (v: unknown): boolean =>
  v === undefined ||
  (v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string'))

/** Reads one project's array of stored configs.
 *
 *  An item with no `type` predates kinds — back then a free-form command was all there was, so
 *  reading it as `shell` is lossless. A corrupt item is dropped silently (same contract as the
 *  sibling stores: one hand-edited item should not turn the whole store into a schema violation
 *  and get it thrown away). */
export function migrateRunConfigs(value: unknown): RunConfig[] {
  if (!Array.isArray(value)) return []
  const out: RunConfig[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
    if (!isStringMap(o.env)) continue
    if (o.cwd !== undefined && typeof o.cwd !== 'string') continue

    if (o.type === undefined) {
      if (typeof o.command !== 'string') continue
      out.push({ ...(o as object), type: 'shell', command: o.command } as RunConfig)
      continue
    }
    if (typeof o.type !== 'string' || !KNOWN.includes(o.type as RunConfigType)) continue
    out.push(o as unknown as RunConfig)
  }
  return out
}
