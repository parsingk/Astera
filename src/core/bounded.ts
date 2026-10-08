// Small bounded collections (performance audit H5): what a long-running process keeps only to say a thing once, or to
// answer a late question, must not grow for the life of the process. Insertion order is age; past the cap the oldest
// goes.
// node: import 없음 — 렌더러도 쓸 수 있다.

/** Adds `key`; true when it was not there (say the thing), false when it was. Past `max`, the oldest is forgotten. */
export function onceBounded(seen: Set<string>, key: string, max: number): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  for (const k of seen) {
    if (seen.size <= max) break
    seen.delete(k)
  }
  return true
}

/** Sets `key`, as the newest entry; past `max`, the oldest go. */
export function setBounded<K, V>(m: Map<K, V>, key: K, value: V, max: number): void {
  m.delete(key)
  m.set(key, value)
  for (const k of m.keys()) {
    if (m.size <= max) break
    m.delete(k)
  }
}
