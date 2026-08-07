// File-operation rules (pure module). The renderer (immediate feedback) and the IPC layer (the
// trust boundary) share the same rules — two copies would inevitably drift apart. Like paths.ts, it
// uses string operations only, no node:path (because it is imported from the renderer's web tsconfig).
import { parentDir } from './paths'
import type { Message } from '../i18n'

// The win32 rules are applied on every platform — this app is win32-first, and if the rules varied
// per OS then the set of names you can create would vary within the same project.
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Whether a name is usable as a file/folder name. Returns the reason it is not (an untranslated
 *  Message), or null when it passes; the checks run in the documented rejection order. The renderer
 *  and the main IPC layer share it, so it does not know the current language — it only builds the
 *  key and the caller does the translation. */
export function validateName(name: string): Message | null {
  if (name.trim() === '') return { key: 'files.validate.empty' }
  if (name === '.' || name === '..') return { key: 'files.validate.reserved' }
  if (name.includes('/') || name.includes('\\')) return { key: 'files.validate.separator' }
  const bad = FORBIDDEN.exec(name)
  if (bad) {
    const ch = bad[0]
    const shown = ch < ' ' ? `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` : ch
    return { key: 'files.validate.badChar', params: { char: shown } }
  }
  if (RESERVED.test(name)) return { key: 'files.validate.windowsReserved' }
  if (name.endsWith(' ') || name.endsWith('.')) return { key: 'files.validate.trailing' }
  if (name.length > 255) return { key: 'files.validate.tooLong' }
  return null
}

/** Splits a name into (stem, extension). For a dot file (.env) or a name with no extension the whole thing is the stem. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, ''] // dot<=0: no extension, or a dot file
  return [name.slice(0, dot), name.slice(dot)]
}

/** The first candidate not in existing. 'a.txt' -> 'a copy.txt' -> 'a copy 2.txt'. Comparison ignores case (win32). */
export function uniqueName(existing: string[], base: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  const [stem, ext] = splitExt(base)
  for (let n = 1; ; n++) {
    const cand = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`
    if (!taken.has(cand.toLowerCase())) return cand
  }
}

// Path normalization — unify separators, lowercase, drop the trailing separator. Mimics the win32
// case-insensitive rule without node:path.
const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Whether target is base itself or below it — the renderer-safe counterpart of isPathWithin in tree.ts. */
export function isSubPath(base: string, target: string): boolean {
  const b = norm(base)
  const t = norm(target)
  return t === b || t.startsWith(b + '\\')
}

/** If p is fromBase itself or below it, replaces that part with toBase. Otherwise returns p unchanged.
 *  Used to update the paths of open tabs on rename/move. Keeps the original separators. */
export function rebasePath(p: string, fromBase: string, toBase: string): string {
  if (!isSubPath(fromBase, p)) return p
  const rest = p.slice(fromBase.length) // includes the leading separator
  return toBase + rest
}

/** Whether src can be moved into destDir. Returns the reason it cannot (a Message) or null. */
export function canMove(src: string, destDir: string): Message | null {
  if (isSubPath(src, destDir)) return { key: 'files.move.intoSelf' }
  if (norm(parentDir(src)) === norm(destDir)) return { key: 'files.move.alreadyThere' }
  return null
}

/** Whether src can be copied into destDir. Returns the reason it cannot (a Message) or null.
 *  Unlike canMove, copying into the same parent is allowed — files.copy sidesteps the collision by
 *  appending ' copy' via uniqueName, so it works as intended. The only thing to block is a copy into
 *  itself or its own descendants (a cycle). Node's fs.cp throws EINVAL in that case too, but we
 *  reject it here first and hand back a Message so its raw English error never reaches the user. */
export function canCopy(src: string, destDir: string): Message | null {
  if (isSubPath(src, destDir)) return { key: 'files.copy.intoSelf' }
  return null
}

/** Drops any path that sits under another path, leaving only the top level. Preserves input order.
 *  When a multi-selection operates on a folder together with its descendants, the child paths are
 *  gone once the parent has moved and the operation fails, so the list is reduced with this first.
 *  Only a *strict* ancestor removes a path (q contains p and p does not contain q) — mutual
 *  containment means they are the same path, and this keeps two duplicates differing only in
 *  separators or case from cancelling each other out and both disappearing. */
export function topLevelOnly(paths: string[]): string[] {
  return paths.filter(
    (p, i) => !paths.some((q, j) => j !== i && isSubPath(q, p) && !isSubPath(p, q))
  )
}
