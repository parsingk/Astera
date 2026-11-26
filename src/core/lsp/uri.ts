// File URIs for language servers (Phase 3 Part 3). A path is written `file:///F:/a%20b/c.ts` on Windows (drive in upper
// case, each segment percent-encoded) and `file:///home/u/c.py` elsewhere. Read back, `file:///f%3A/...` (TypeScript 7's
// spelling, measured 2026-11-26) and `file:///F:/...` give one path. A UNC share, a device path and any URI with an
// authority are refused both ways: a server is never pointed at another machine.

/** Two separators in front: a UNC share, a `\\?\` or `\\.\` device path, or the `//` spelling of either (the pattern
 *  src/main/run/resolveLink.ts names UNC_LIKE; copied, since the Host may not import main). */
const UNC_LIKE = /^[\\/]{2}/

const encodeSegments = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

export function pathToUri(p: string, platform: string): string | null {
  if (UNC_LIKE.test(p)) return null
  if (platform === 'win32') {
    const slashed = p.replace(/\\/g, '/')
    const drive = /^([A-Za-z]):\//.exec(slashed)
    if (!drive) return null
    return `file:///${drive[1].toUpperCase()}:/${encodeSegments(slashed.slice(3))}`
  }
  if (!p.startsWith('/')) return null
  return `file://${encodeSegments(p)}`
}

export function uriToPath(uri: string, platform: string): string | null {
  if (!uri.startsWith('file://')) return null
  const rest = uri.slice('file://'.length)
  // An authority (`file://srv/...`) or an empty one followed by another slash (`file:////srv/...`) names another machine
  if (!rest.startsWith('/') || rest.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  if (platform === 'win32') {
    const drive = /^\/([A-Za-z]):(\/|$)/.exec(decoded)
    if (!drive) return null
    return `${drive[1].toUpperCase()}:\\${decoded.slice(4).replace(/\//g, '\\')}`
  }
  return UNC_LIKE.test(decoded) ? null : decoded
}
