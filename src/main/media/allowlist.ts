import path from 'node:path'
import { foldPathCase } from '../../core/files/paths'
import { mediaKindOf } from '../../core/files/media'

/** The files the media protocol (./protocol.ts) may serve: the ones the renderer was told exist, by
 *  files.resolveLink (a session terminal's link, or a SendUserFile row resolving its paths before
 *  opening them). The protocol is reachable from any page the renderer loads, so "the URL names a
 *  media file" is not enough — without this, astera-media:// would be a read of any image or video on
 *  the machine by spelling its path. In memory only: a restart forgets it, and the next link the
 *  person clicks resolves (and admits) its file again.
 *
 *  Only media is ever admitted, so a resolved link to a source file or a key never becomes servable
 *  here; that is files.read's business, under its own guard. Keys are normalised (`..` folded) and
 *  case-folded where the filesystem ignores case, the same rule core/files/paths.ts gives every other
 *  path comparison. `platform` is a parameter so the win32 rule can be tested on any runner. */
export function createMediaAllowlist(platform: string = process.platform): {
  add(p: string): boolean
  has(p: string): boolean
} {
  const lib = platform === 'win32' ? path.win32 : path.posix
  const keyOf = (p: string): string | null =>
    lib.isAbsolute(p) && mediaKindOf(p) !== null ? foldPathCase(lib.normalize(p), platform) : null
  const keys = new Set<string>()
  return {
    add(p) {
      const k = keyOf(p)
      if (k === null) return false
      keys.add(k)
      return true
    },
    has(p) {
      const k = keyOf(p)
      return k !== null && keys.has(k)
    }
  }
}

/** The one list main uses — files.resolveLink adds to it, the protocol and the media.* IPC read it. */
export const mediaAllowlist = createMediaAllowlist()
