import type { Terminal } from '@xterm/xterm'

/** The cell pixel dimensions xterm has already computed — FitAddon reads the same path */
type WithRenderService = {
  _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
}

/**
 * Sizes the terminal by dividing the container by the cell grid directly. A replacement for
 * FitAddon.fit().
 *
 * Why FitAddon is not used: when deciding the column count FitAddon always subtracts room for a vertical
 * scrollbar, and when that measures as 0 xterm's Viewport falls back to a default of 15px
 * (`(viewportElement.offsetWidth - scrollArea.offsetWidth) || DEFAULT_SCROLL_BAR_WIDTH`).
 * So even with the scrollbar hidden in CSS, 15px on the right stayed empty and the session pane looked
 * shorter than the bottom status bar line — measured, FitAddon leaves 14~22px on the right and this
 * function leaves 1~7px.
 *
 * The remaining margin is only the remainder of dividing by the cell width and height (at most
 * cellWidth-1 and cellHeight-1 respectively), so the grid structure makes it impossible to shrink
 * further. If the container has padding, clientWidth/Height already come back smaller by that much, so
 * unlike FitAddon this does not count the padding twice.
 *
 * @returns true if the size actually changed
 */
export function fitTerminalToHost(term: Terminal, host: HTMLElement): boolean {
  const cell = (term as unknown as WithRenderService)._core?._renderService?.dimensions?.css?.cell
  // Before the first render the cell dimensions are 0 — dividing then produces an absurd size, so it is
  // skipped and left to the next ResizeObserver callback
  if (!cell?.width || !cell.height) return false
  const cols = Math.max(2, Math.floor(host.clientWidth / cell.width))
  const rows = Math.max(1, Math.floor(host.clientHeight / cell.height))
  if (cols === term.cols && rows === term.rows) return false
  term.resize(cols, rows)
  return true
}
