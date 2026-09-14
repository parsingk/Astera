/** What an image type is called on disk. Anything else keeps whatever extension its name carried. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
}

/**
 * A filename to save something dropped or pasted into the composer under.
 *
 * The name it arrives with is not a name this app may write: it comes from a clipboard or another
 * application, and `..`, a slash, or a drive letter in it would put the file somewhere nobody asked
 * for. Everything outside a small safe set becomes `-`, and the parts that could climb out of the
 * folder cannot survive that.
 *
 * A clipboard image usually arrives with no name at all, so one is made from the time, which also
 * keeps two pastes in the same second from being the same file.
 */
export function attachmentNameOf(raw: string, mime: string, now: Date, nonce: number): string {
  const stamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0')

  const extension = EXTENSIONS[mime] ?? extensionOf(raw)
  const base = safe(stripExtension(raw))
  const stem = base === '' ? `pasted-${stamp}` : `${base}-${stamp}`
  return `${stem}-${nonce}${extension}`
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot)
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : ''
}

/** Letters, digits, dot, dash and underscore survive; everything else becomes a dash, and runs of
 *  dashes collapse. A name that is nothing but unsafe characters comes back empty, which is the
 *  caller's cue to name it after the clock instead. */
function safe(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
}
