// What a preview guest page may do. Pure so vitest can run it; main/preview/guest.ts wires these
// into Electron's events. The page that runs in the preview is the developer's dev server, but a dev
// server pulls in libraries, CDNs and login redirects — code nobody here wrote — so the guest gets a
// room with nothing of this app in it.
import { isLoopbackUrl } from './url'

/** One partition for every preview tab. Cookies and storage are per origin (port included), so two
 *  projects' dev servers do not see each other's state; the user's own browser is not involved at all. */
export const PREVIEW_PARTITION = 'persist:preview'

/** May this <webview> attach? Its partition must be the preview's, and its initial src must be a web
 *  page or blank — a `file:` or `javascript:` src written into the tag is the one way a page could
 *  reach past the guest, so it is refused before the guest exists. */
export function guestAttachAllowed(p: { src?: string; partition?: string }): boolean {
  if (p.partition !== PREVIEW_PARTITION) return false
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
