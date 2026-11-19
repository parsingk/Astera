import type { Terminal } from '@xterm/xterm'
import { copyTextFor } from '../../../core/terminal/copy'

/**
 * The copy key the session terminal (TerminalView), the Run console (RunPanel) and the remote terminal each wire inline,
 * for the bottom panel's terminal (TerminalBody), whose key handler has only this and the file paste key
 * (terminalFilePaste.ts). Ctrl+C, Cmd+C on macOS, over a selection copies it and
 * clears the selection instead of reaching the shell; with nothing to copy the key goes through as before (an interrupt
 * on Windows and Linux). The text is caught when the selection is made, for the reason core/terminal/copy.ts gives: a
 * program that draws over the screen leaves the selection pointing at something else.
 * `key` is the shape attachCustomKeyEventHandler takes: false means the key was used here.
 */
export function selectionCopy(
  term: Terminal,
  o: { isMac: boolean; writeText: (text: string) => void }
): { key: (e: KeyboardEvent) => boolean; dispose: () => void } {
  let latched = ''
  const latch = term.onSelectionChange(() => {
    latched = term.getSelection()
  })
  const copyMod = (e: KeyboardEvent): boolean => (o.isMac ? e.metaKey : e.ctrlKey)
  const otherMod = (e: KeyboardEvent): boolean => (o.isMac ? e.ctrlKey : e.metaKey)
  const key = (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown' || (e.key !== 'c' && e.key !== 'C') || !copyMod(e) || otherMod(e) || e.altKey || e.shiftKey) {
      return true
    }
    const text = copyTextFor(latched, term.getSelection())
    if (text === null) return true
    o.writeText(text)
    term.clearSelection()
    latched = ''
    return false
  }
  return { key, dispose: () => latch.dispose() }
}
