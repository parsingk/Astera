// The preview's URL rules. Pure — the renderer's link handler, the run:status auto-open, the run
// configuration save check and main's guest guards all import these, so "does this address mean this
// machine?" has one answer in the app.
// node: no imports — the renderer imports this file.

/** `new URL(u).href` — the canonical spelling the tab-reuse rule compares by (a trailing slash is
 *  added to a bare origin, the host is lowercased). null when the string does not parse as a URL. */
export function normalizeUrl(u: string): string | null {
  try {
    return new URL(u).href
  } catch {
    return null
  }
}

/** Parses, and is http: or https:. What run.saveConfigs accepts as a previewUrl. `localhost:5173`
 *  fails on purpose: the URL parser reads `localhost` as the scheme, which is not a page anyone can open. */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Does `u` point at this machine? http/https only, and a host of `localhost`, `*.localhost`,
 *  `127.0.0.0/8`, `[::1]`, `0.0.0.0` or `[::]`. The last two are "every interface" — a dev server that
 *  prints them is reachable here even though a browser cannot navigate to them (previewTargetOf).
 *  `URL.hostname` is already lowercased, and an IPv6 host keeps its brackets. */
export function isLoopbackUrl(u: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    LOOPBACK_V4.test(host) ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host === '[::]'
  )
}

/** The address the preview loads. `0.0.0.0` and `[::]` become `localhost`; anything else is returned
 *  as given — byte for byte, so a URL that needed no rewrite stays the string the console printed. */
export function previewTargetOf(u: string): string {
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return u
  }
  if (parsed.hostname !== '0.0.0.0' && parsed.hostname !== '[::]') return u
  parsed.hostname = 'localhost'
  return parsed.href
}

/** The one link rule: a loopback address opens in the preview, anything else outside; the modifier
 *  (Ctrl, or Cmd on macOS) inverts it. */
export function linkDestination(u: string, opts: { modifier: boolean }): 'preview' | 'external' {
  return isLoopbackUrl(u) !== opts.modifier ? 'preview' : 'external'
}

/** `host:port` for a message about the address ("localhost:5173 is not responding"), the input itself
 *  when it does not parse — a message with nothing in it is worse than one with an odd string. */
export function displayHostOf(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return u
  }
}
