// Terminal PTY resize dedupe. On a tab switch the inactive tab is display:none (size 0), so when it is
// shown again ResizeObserver fires with size 0 → the real size. Passing that resize through even when
// the dimensions match the previous ones makes node-pty/conpty signal a resize to the child (Claude),
// which re-renders and shifts interactive TUI elements (tables, select boxes) around. So a pure
// function decides to send only when the dimensions differ from the last ones sent.

export interface Dims {
  cols: number
  rows: number
}

/** Returns null (skip sending) when the dimensions equal the last ones sent to the PTY, or the dimensions to send when they differ or it is the first time (last=null). */
export function nextResize(last: Dims | null, cols: number, rows: number): Dims | null {
  if (last && last.cols === cols && last.rows === rows) return null
  return { cols, rows }
}
