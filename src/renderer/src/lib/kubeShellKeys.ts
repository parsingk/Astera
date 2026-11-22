/** The keys a shell tab's view takes for itself instead of typing them into the container (spec 4.8): find (Ctrl+F, Cmd+F
 *  on macOS) and paste (Ctrl+V, Ctrl+Shift+V, Cmd+V on macOS). Keydown only, the platform modifier without the other one
 *  and without Alt, as the terminals' copy and file paste read it. Find is not for Shift. */
export function shellKeyAction(
  e: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean
): 'find' | 'paste' | null {
  if (e.type !== 'keydown' || e.altKey) return null
  const mod = isMac ? e.metaKey : e.ctrlKey
  const other = isMac ? e.ctrlKey : e.metaKey
  if (!mod || other) return null
  const k = e.key.toLowerCase()
  if (k === 'f' && !e.shiftKey) return 'find'
  if (k === 'v') return 'paste'
  return null
}
