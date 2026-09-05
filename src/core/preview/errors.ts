// Which of Chromium's load errors the preview shows how. The codes are net_error_list.h values as
// the <webview> did-fail-load event reports them.
// node: no imports — the renderer imports this file.

export type LoadErrorKind = 'unreachable' | 'ignored' | 'other'

// -102 ERR_CONNECTION_REFUSED, -105 ERR_NAME_NOT_RESOLVED, -109 ERR_ADDRESS_UNREACHABLE — nobody is
// listening at that address, which for a dev server means "not up yet" or "gone".
const UNREACHABLE = new Set([-102, -105, -109])

/** -3 ERR_ABORTED is not a failure: it is what a navigation reports when another navigation
 *  superseded it (a reload during a load, a redirect chain). Showing it would flash an error screen
 *  over a page that is about to appear. */
export function loadErrorKind(code: number): LoadErrorKind {
  if (code === -3) return 'ignored'
  return UNREACHABLE.has(code) ? 'unreachable' : 'other'
}
