import type { Terminal } from '@xterm/xterm'

/**
 * Files copied outside the app (Explorer, Finder) pasted into a terminal type their paths: the session terminal
 * (TerminalView) and the bottom panel's terminal (TerminalBody) wire these three. The file list exists only on the
 * browser's paste event: main reads the first file at most, and nothing else hands the list over (measured 2026-09-08,
 * memory electron-file-clipboard-and-drag). So the paste key is let through unprevented while the clipboard holds files,
 * and the paths are taken from the event that follows it.
 */

/** The text a paste of these paths types: separated by a space, a path holding whitespace in double quotes, the same
 *  on every OS, and one space after so typing can go on. An empty path (a picture copied as an image has none) is
 *  dropped; null when none is left. */
export function filePasteText(paths: readonly string[]): string | null {
  const kept = paths.filter((p) => p !== '')
  if (kept.length === 0) return null
  return kept.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' '
}

/** The paste key (Ctrl+V, Cmd+V on macOS; Shift allowed, Alt and the other modifier not, as the session terminal's text
 *  paste reads it) while the clipboard holds files. A key handler returns false for it without preventDefault, so xterm
 *  leaves the key alone and the browser's paste event follows. `hasFiles` is asked only once the key matches. */
export function isFilePasteKey(e: KeyboardEvent, o: { isMac: boolean; hasFiles: () => boolean }): boolean {
  if (e.type !== 'keydown' || (e.key !== 'v' && e.key !== 'V') || e.altKey) return false
  const mod = o.isMac ? e.metaKey : e.ctrlKey
  const other = o.isMac ? e.ctrlKey : e.metaKey
  return mod && !other && o.hasFiles()
}

/** Takes a paste event that lists files with paths before xterm's own textarea handler sees it (capture, on the host)
 *  and types their paths through `term.paste`, bracketed when the program asked for it like any paste. An event with no
 *  path left goes on to xterm, which pastes its text. Returns the remover. */
export function attachFilePaste(host: HTMLElement, term: Pick<Terminal, 'paste'>, pathOf: (file: File) => string): () => void {
  const onPaste = (e: ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? [])
    const text = filePasteText(files.map(pathOf))
    if (text === null) return
    e.preventDefault()
    e.stopPropagation()
    term.paste(text)
  }
  host.addEventListener('paste', onPaste, true)
  return () => host.removeEventListener('paste', onPaste, true)
}
