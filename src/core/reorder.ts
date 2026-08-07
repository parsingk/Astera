/** Returns a new array with the item at fromIndex moved in front of the insertBefore position
 *  (indexed against the original, 0..length); the original is untouched. A pure helper for session
 *  tab drag reordering.
 *  insertBefore=length means the very end. Out of range, or a result identical to the input, returns
 *  a shallow copy of the original. */
export function reorder<T>(list: T[], fromIndex: number, insertBefore: number): T[] {
  const n = list.length
  if (fromIndex < 0 || fromIndex >= n || insertBefore < 0 || insertBefore > n) return list.slice()
  // Its own place (before=fromIndex, after=fromIndex+1) is a no-op
  if (insertBefore === fromIndex || insertBefore === fromIndex + 1) return list.slice()
  const next = list.slice()
  const [moved] = next.splice(fromIndex, 1)
  // Removing fromIndex pulls every position after it back by one
  const target = insertBefore > fromIndex ? insertBefore - 1 : insertBefore
  next.splice(target, 0, moved)
  return next
}
