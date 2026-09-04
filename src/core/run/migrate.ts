import type { RunConfig, RunConfigType } from './types'

const KNOWN: RunConfigType[] = [
  'shell', 'npm', 'node', 'gradle', 'maven', 'cargo', 'go', 'python', 'pytest', 'compose', 'dockerfile',
  'dotnet', 'compound'
]

/** The string fields a kind must have. Missing one means buildCommand would splice `undefined` into
 *  the assembled command — this is the gate that stops that. A Record so adding a kind without a
 *  line here fails the build (see the file structure table's later tasks, which each add one).
 *  Exported so the "is this runnable yet" question (missingRequiredFields below, used by run.start)
 *  and the tests that walk every kind read the same list this gate does. */
export const REQUIRED: Record<RunConfigType, readonly string[]> = {
  shell: ['command'],
  npm: ['script'],
  node: ['file'],
  gradle: ['tasks'],
  maven: ['goals'],
  cargo: ['subcommand'],
  go: ['subcommand'],
  python: ['file'],
  // No required field — an empty target runs the whole suite, so there is nothing to reject here
  pytest: [],
  // No required field — an empty composeFile falls back to what the project context found (or to
  // docker compose's own search), and an empty services list means "every service"
  compose: [],
  dockerfile: ['imageTag'],
  dotnet: ['project'],
  // members is an array, so this string-field table cannot express it. missingRequiredFields below
  // is where an empty member list is reported.
  compound: []
}

const isStringMap = (v: unknown): boolean =>
  v === undefined ||
  (v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string'))

const isStringArray = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/** Which of a kind's required fields are still empty. A configuration in this state is storable but
 *  not runnable — run.start refuses it by name rather than assembling a command with a hole in it.
 *  The same rule migrateRunConfigs applies below, but to a value that is already typed. */
export function missingRequiredFields(config: RunConfig): string[] {
  if (config.type === 'compound') return config.members.length === 0 ? ['members'] : []
  const o = config as unknown as Record<string, unknown>
  return REQUIRED[config.type].filter((k) => typeof o[k] !== 'string' || o[k] === '')
}

/** Reads one project's array of stored configs.
 *
 *  An item with no `type` predates kinds — back then a free-form command was all there was, so
 *  reading it as `shell` is lossless. A corrupt item is dropped silently (same contract as the
 *  sibling stores: one hand-edited item should not turn the whole store into a schema violation
 *  and get it thrown away).
 *
 *  `allowIncomplete` keeps everything above but stops rejecting a required field that is present and
 *  empty. run.saveConfigs passes it, because a configuration created by ＋ starts with exactly that
 *  shape: without it the new configuration never reaches the store, lives only in the renderer's
 *  single `pending` slot, and the next ＋ silently loses it. **RunConfigStore.load passes it too, and
 *  must:** the two have to agree, or the app writes a file it then refuses to read back and the
 *  half-filled configuration disappears at the next start with nothing said. What refuses an
 *  incomplete configuration is run.start, by name (missingRequiredFields above) — the point where it
 *  would otherwise become a command with a hole in it. */
export function migrateRunConfigs(value: unknown, opts?: { allowIncomplete?: boolean }): RunConfig[] {
  if (!Array.isArray(value)) return []
  const out: RunConfig[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const o = raw as Record<string, unknown>
    // Blank is rejected, not just the wrong type. The name is the only thing identifying a
    // configuration in the tree and in the run widget's selector, so a blank one is a row nobody can
    // see or point at — and this function is also run.saveConfigs' gate, so a renderer that let a
    // blank through (it did) must not be able to store one.
    if (typeof o.id !== 'string' || o.id.trim() === '') continue
    if (typeof o.name !== 'string' || o.name.trim() === '') continue
    if (!isStringMap(o.env)) continue
    if (o.cwd !== undefined && typeof o.cwd !== 'string') continue
    if (o.folder !== undefined && typeof o.folder !== 'string') continue
    if (o.allowMultipleInstances !== undefined && typeof o.allowMultipleInstances !== 'boolean') continue
    if (o.temporary !== undefined && typeof o.temporary !== 'boolean') continue
    if (!isStringArray(o.beforeLaunch)) continue

    if (o.type === undefined) {
      if (typeof o.command !== 'string') continue
      out.push({ ...(o as object), type: 'shell', command: o.command } as RunConfig)
      continue
    }
    if (typeof o.type !== 'string' || !KNOWN.includes(o.type as RunConfigType)) continue
    // The one kind whose required content is not a string field. An absent or wrongly typed member
    // list is a corrupt item and is dropped; an empty one is a value this app stores (＋ creates
    // exactly that) and missingRequiredFields is what refuses to run it.
    if (o.type === 'compound') {
      if (!Array.isArray(o.members) || !o.members.every((x) => typeof x === 'string')) continue
      out.push(o as unknown as RunConfig)
      continue
    }
    // The type check always applies — a missing or non-string required field is what would splice
    // `undefined` into the command. Only the emptiness half is relaxed by allowIncomplete.
    const required = REQUIRED[o.type as RunConfigType]
    if (required.some((k) => typeof o[k] !== 'string')) continue
    if (!opts?.allowIncomplete && required.some((k) => o[k] === '')) continue
    out.push(o as unknown as RunConfig)
  }
  return out
}
