import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mediaUrl } from '../../core/files/media'
import { createMediaAllowlist } from './allowlist'
import { handleMediaRequest, parseRange } from './protocol'

describe('parseRange', () => {
  it('reads a closed, an open-ended and a suffix range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('clamps an end past the file to its last byte', () => {
    expect(parseRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 })
  })

  it('a start at or past the end of the file is unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable')
  })

  // RFC 9110 lets a server ignore a Range it does not handle and send the whole file — better than
  // refusing a request the element would then not retry
  it('a malformed, inverted or multi-part range is ignored (null): the whole file is sent', () => {
    for (const h of ['', 'items=0-1', 'bytes=', 'bytes=a-b', 'bytes=9-3', 'bytes=0-1,5-6', 'bytes=-0']) {
      expect(parseRange(h, 100), h).toBeNull()
    }
  })
})

describe('createMediaAllowlist', () => {
  it('admits a media path it was given, and only that', () => {
    const list = createMediaAllowlist()
    const p = path.resolve('/clips/g1.mp4')
    expect(list.add(p)).toBe(true)
    expect(list.has(p)).toBe(true)
    expect(list.has(path.resolve('/clips/g2.mp4'))).toBe(false)
  })

  it('refuses to hold a path that is not media', () => {
    const list = createMediaAllowlist()
    expect(list.add(path.resolve('/notes/secret.txt'))).toBe(false)
    expect(list.has(path.resolve('/notes/secret.txt'))).toBe(false)
  })

  it('normalises: the same file spelled with `..` is the same entry', () => {
    const list = createMediaAllowlist()
    list.add(path.resolve('/clips/a/../g1.mp4'))
    expect(list.has(path.resolve('/clips/g1.mp4'))).toBe(true)
  })

  it('folds case where the platform does', () => {
    const win = createMediaAllowlist('win32')
    win.add('D:\\Clips\\G1.mp4')
    expect(win.has('d:\\clips\\g1.MP4')).toBe(true)
    expect(win.has('D:\\Clips\\x\\..\\G1.mp4')).toBe(true)
    const linux = createMediaAllowlist('linux')
    linux.add('/Clips/G1.mp4')
    expect(linux.has('/clips/g1.mp4')).toBe(false)
  })

  it('a relative path is never admitted', () => {
    const list = createMediaAllowlist()
    expect(list.add('clips/g1.mp4')).toBe(false)
    expect(list.has('clips/g1.mp4')).toBe(false)
  })
})

describe('handleMediaRequest', () => {
  let dir: string
  let video: string
  let text: string
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-media-'))
    video = path.join(dir, 'clip.mp4')
    text = path.join(dir, 'notes.txt')
    await fs.writeFile(video, bytes)
    await fs.writeFile(text, 'secret')
  })

  const get = (p: string, headers: Record<string, string> = {}, method = 'GET'): Request =>
    new Request(mediaUrl(p, 123), { method, headers })

  it('refuses a media path that was never allowlisted, without touching the disk', async () => {
    const stat = vi.fn((p: string) => fs.stat(p))
    const res = await handleMediaRequest(get(video), { allowed: () => false, stat })
    expect(res.status).toBe(403)
    expect(stat).not.toHaveBeenCalled()
  })

  it('refuses a path that is not media even when the allowlist would say yes', async () => {
    const stat = vi.fn((p: string) => fs.stat(p))
    const res = await handleMediaRequest(get(text), { allowed: () => true, stat })
    expect(res.status).toBe(403)
    expect(stat).not.toHaveBeenCalled()
  })

  it('a URL that is not ours is 404', async () => {
    const res = await handleMediaRequest(new Request('astera-media://other/x.mp4'), { allowed: () => true })
    expect(res.status).toBe(404)
  })

  it('an allowlisted file that has since gone is 404', async () => {
    const res = await handleMediaRequest(get(path.join(dir, 'gone.mp4')), { allowed: () => true })
    expect(res.status).toBe(404)
  })

  it('serves the whole file with 200 when there is no Range, and says ranges are accepted', async () => {
    const res = await handleMediaRequest(get(video), { allowed: (p) => p === video })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('serves 206 with the right Content-Range, length and bytes for a Range request', async () => {
    const res = await handleMediaRequest(get(video, { Range: 'bytes=100-199' }), { allowed: () => true })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true)
  })

  it('an open-ended range — what <video> sends when it seeks — runs to the end of the file', async () => {
    const res = await handleMediaRequest(get(video, { Range: 'bytes=900-' }), { allowed: () => true })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(900))).toBe(true)
  })

  it('an unsatisfiable range is 416 with the size in Content-Range', async () => {
    const res = await handleMediaRequest(get(video, { Range: 'bytes=5000-' }), { allowed: () => true })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */1000')
  })

  it('HEAD answers the headers with no body', async () => {
    const res = await handleMediaRequest(get(video, {}, 'HEAD'), { allowed: () => true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.body).toBeNull()
  })

  it('anything but GET or HEAD is 405', async () => {
    const res = await handleMediaRequest(get(video, {}, 'POST'), { allowed: () => true })
    expect(res.status).toBe(405)
  })

  it('a directory named like media is 404, not a stream of nothing', async () => {
    const d = path.join(dir, 'folder.mp4')
    await fs.mkdir(d, { recursive: true })
    const res = await handleMediaRequest(get(d), { allowed: () => true })
    expect(res.status).toBe(404)
  })
})
