/** Decides the `-n` flag. kubectl rejects an object whose `metadata.namespace` differs from a passed `-n`,
 *  so the flag is only a default for resources that name none. */

export type NamespaceFlag =
  | { ok: true; flag: string | null }
  | { ok: false; conflicts: { path: string; namespace: string }[] }

export function namespaceFlag(items: { path: string; namespace: string | null }[], pill: string | null): NamespaceFlag {
  // Every resource names its namespace: the flag would add nothing and could only clash.
  if (items.every((i) => i.namespace !== null)) return { ok: true, flag: null }
  if (pill === null) return { ok: true, flag: null }
  const conflicts: { path: string; namespace: string }[] = []
  for (const i of items) if (i.namespace !== null && i.namespace !== pill) conflicts.push({ path: i.path, namespace: i.namespace })
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, flag: pill }
}
