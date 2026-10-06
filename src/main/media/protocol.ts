import { createReadStream, promises as fsp } from 'node:fs'
import { Readable } from 'node:stream'
import { mediaMime, pathOfMediaUrl } from '../../core/files/media'

/** A single byte range, inclusive at both ends as HTTP counts them; 'unsatisfiable' when the range
 *  starts past the file; null when the header is absent, malformed or asks for several ranges — RFC
 *  9110 lets a server ignore such a Range and send the whole file, which <video> handles, where a
 *  refusal would leave it with nothing. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // `bytes=-N`: the last N bytes
    const n = Number(m[2])
    if (n === 0) return null
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (m[2] !== '' && Number(m[2]) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
}

export interface MediaDeps {
  /** Whether the renderer was told this path exists (./allowlist.ts). */
  allowed: (p: string) => boolean
  stat?: (p: string) => Promise<{ isFile(): boolean; size: number }>
  /** The bytes `start..end` (inclusive) of `p`, as a web stream. */
  open?: (p: string, start: number, end: number) => ReadableStream<Uint8Array>
}

const openRange = (p: string, start: number, end: number): ReadableStream<Uint8Array> =>
  Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream<Uint8Array>

const status = (code: number, headers?: Record<string, string>): Response => new Response(null, { status: code, headers })

/** The astera-media:// handler (registered in main/index.ts through protocol.handle). Kept apart
 *  from Electron so its rules can be tested with a plain Request: the extension must be media and the
 *  path allowlisted — both checked before anything touches the disk, so a refused URL cannot even
 *  learn whether the file exists — and a Range request gets a real 206.
 *
 *  Range is done here, by reading the slice with createReadStream, rather than by handing the request
 *  to net.fetch on a file:// URL: whether Electron's file loader honours Range has changed between
 *  versions, and a <video> that gets a 200 for every seek plays from the start or not at all. Doing
 *  it here also keeps file:// out of the picture entirely. */
export async function handleMediaRequest(req: Request, deps: MediaDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return status(405)
  const p = pathOfMediaUrl(req.url)
  if (p === null) return status(404)
  const mime = mediaMime(p)
  if (!mime || !deps.allowed(p)) return status(403)
  const stat = deps.stat ?? fsp.stat
  let size: number
  try {
    const st = await stat(p)
    if (!st.isFile()) return status(404)
    size = st.size
  } catch {
    return status(404)
  }
  // The query carries the file's mtime (core/files/media.ts mediaUrl), so a regenerated file is a
  // new URL; no-cache on top keeps a reused URL from being answered from a stale copy.
  const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
  const range = parseRange(req.headers.get('range'), size)
  if (range === 'unsatisfiable') return status(416, { ...base, 'Content-Range': `bytes */${size}` })
  const open = deps.open ?? openRange
  const head = req.method === 'HEAD'
  if (range === null) {
    const headers = { ...base, 'Content-Length': String(size) }
    // An empty file has no range to read; createReadStream's end of -1 would read the whole file
    return new Response(head || size === 0 ? null : open(p, 0, size - 1), { status: 200, headers })
  }
  const headers = {
    ...base,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Content-Length': String(range.end - range.start + 1)
  }
  return new Response(head ? null : open(p, range.start, range.end), { status: 206, headers })
}
