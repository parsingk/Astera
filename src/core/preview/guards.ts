// What a preview guest page may do. Pure so vitest can run it; main/preview/guest.ts wires these
// into Electron's events. The page that runs in the preview is the developer's dev server, but a dev
// server pulls in libraries, CDNs and login redirects — code nobody here wrote — so the guest gets a
// room with nothing of this app in it.
import { isLoopbackUrl } from './url'

/** One partition for every preview tab. Cookies and storage are per origin (port included), so two
 *  projects' dev servers do not see each other's state; the user's own browser is not involved at all. */
export const PREVIEW_PARTITION = 'persist:preview'

/** A sandboxed session's agent browser gets a partition of its own, so its pages carry none of the person's
 *  cookies, storage or logins from `persist:preview`. No `persist:` prefix: Electron keeps such a partition in
 *  memory only, so it starts empty each app run and nothing reaches disk
 *  (https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options). One per session
 *  rather than one for all of them, so two sandboxed sessions do not see each other's state either; the cost is
 *  one in-memory session per sandboxed session that opens a page. */
export const SANDBOX_PARTITION_PREFIX = 'agent-sandbox-'

/** The partition an agent browser tab for `sessionId` lives in. The id is percent-encoded, with `%` itself
 *  carried through, so two ids never meet and the name stays one the guard recognises. */
export function agentPartitionFor(sessionId: string, sandboxed: boolean): string {
  if (!sandboxed) return PREVIEW_PARTITION
  return SANDBOX_PARTITION_PREFIX + encodeURIComponent(sessionId).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))
}

/** Is this a sandboxed session's partition: the prefix, then a non-empty encoded id. */
export function isSandboxPartition(partition: string | undefined): boolean {
  return (
    typeof partition === 'string' &&
    partition.startsWith(SANDBOX_PARTITION_PREFIX) &&
    /^[A-Za-z0-9._~%-]+$/.test(partition.slice(SANDBOX_PARTITION_PREFIX.length))
  )
}

/** May this <webview> attach? Its partition must be the preview's or a sandboxed session's own, and its initial src must be a web
 *  page or blank — a `file:` or `javascript:` src written into the tag is the one way a page could
 *  reach past the guest, so it is refused before the guest exists. */
export function guestAttachAllowed(p: { src?: string; partition?: string }): boolean {
  if (p.partition !== PREVIEW_PARTITION && !isSandboxPartition(p.partition)) return false
  const src = p.src ?? ''
  if (src === '' || src === 'about:blank') return true
  return guestNavigationAllowed(src)
}

/** May the guest navigate to `url`? http and https only. */
export function guestNavigationAllowed(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

/** The agent's tab is held to this machine; the user's preview keeps the wider rule. A `click()` on
 *  an external link in the agent's tab is refused here, so the "dev server only" line holds for
 *  navigations the page starts, not only for `open()`. */
export function agentNavigationAllowed(url: string, isAgentGuest: boolean): boolean {
  return isAgentGuest ? isLoopbackUrl(url) : guestNavigationAllowed(url)
}

/** May a page ask for a permission (camera, microphone, notifications, ...)? Only a page served from
 *  this machine — testing a webcam feature on the dev server is the use; granting it to arbitrary
 *  sites is not. */
export function permissionAllowed(requestingUrl: string): boolean {
  return isLoopbackUrl(requestingUrl)
}

/** May a certificate error be waved through? Only for a preview guest, and only for a loopback
 *  address — `https://localhost` with a self-signed (mkcert) certificate is everyday dev HTTPS. The
 *  app's own window never gets this. */
export function certificateAllowed(url: string, contentsType: string): boolean {
  return contentsType === 'webview' && isLoopbackUrl(url)
}
