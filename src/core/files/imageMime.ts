/** Extension (lowercase, no dot) -> MIME type for the markdown preview's inline images
 *  (files.readDataUrl in src/main/ipc.ts). Deliberately an allowlist, not a synthesised string: an
 *  extension not in this table is refused rather than guessed, so a hostile file cannot ride an
 *  arbitrary MIME token into a data URL.
 *  svg is included but is only ever used inside an <img src="data:image/svg+xml..."> — the browser does
 *  not execute scripts for an image loaded that way. Never render it as inline <svg> (markdownTree's
 *  DROP_TAGS keeps that from happening on the rendering side). */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml'
}

/** Looks up only the table's own keys. A plain object literal's bracket lookup otherwise falls through
 *  to Object.prototype for names like `constructor` or `__proto__`, returning a truthy, stringifiable
 *  value (a function, an object) instead of undefined — the same defence as icons.ts's `own`, needed
 *  here for the same reason. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** ext -> MIME, or undefined when ext (case-insensitive) is not on the allowlist. Extraction into a
 *  pure function makes this the one part of files.readDataUrl this repo's unit-test style can reach —
 *  the handler itself is bound to ipcMain and Electron's fs, which is not. */
export function imageMime(ext: string): string | undefined {
  return own(IMAGE_MIME, ext.toLowerCase())
}
