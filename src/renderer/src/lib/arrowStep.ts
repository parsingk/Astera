/** The item an arrow key moves to in a row of tabs or radios (ARIA's tabs and radio group patterns): the next one with
 *  ArrowRight, the one before with ArrowLeft, wrapping at the ends; with `upDown` (a radio group) ArrowDown and ArrowUp
 *  do the same. Null for any other key; the first item when `current` is not among them. */
export function arrowStep<T>(items: readonly T[], current: T, key: string, upDown = false): T | null {
  const step = key === 'ArrowRight' || (upDown && key === 'ArrowDown') ? 1 : key === 'ArrowLeft' || (upDown && key === 'ArrowUp') ? -1 : 0
  if (step === 0 || items.length === 0) return null
  const at = items.indexOf(current)
  return at < 0 ? items[0] : items[(at + step + items.length) % items.length]
}
