import { describe, it, expect } from 'vitest'
import { mediaKindOf, mediaMime, mediaUrl, mediaVersion, pathOfMediaUrl, reloadStep, resumeAt, type ReloadState } from './media'

describe('mediaKindOf', () => {
  it('names the video extensions the viewer plays', () => {
    for (const p of ['a.mp4', 'b.mov', 'c.webm', 'd.m4v']) expect(mediaKindOf(p), p).toBe('video')
  })

  it('names the image extensions the viewer shows', () => {
    for (const p of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif']) expect(mediaKindOf(p), p).toBe('image')
  })

  it('is case-insensitive, and reads the extension off a full Windows or POSIX path', () => {
    expect(mediaKindOf('D:\\clips\\G1.MP4')).toBe('video')
    expect(mediaKindOf('/tmp/shots/Tile.PnG')).toBe('image')
  })

  it('is null for anything else: other extensions, no extension, a dot folder, prototype names', () => {
    for (const p of ['a.ts', 'a.svg', 'a.avi', 'README', 'D:\\x.mp4\\file', '/a/.mp4', 'a.constructor', 'a.__proto__']) {
      expect(mediaKindOf(p), p).toBeNull()
    }
  })
})

describe('mediaMime', () => {
  it('maps each media extension to its MIME type, and nothing else', () => {
    expect(mediaMime('x.mp4')).toBe('video/mp4')
    expect(mediaMime('x.MOV')).toBe('video/quicktime')
    expect(mediaMime('x.webm')).toBe('video/webm')
    expect(mediaMime('x.m4v')).toBe('video/x-m4v')
    expect(mediaMime('x.jpg')).toBe('image/jpeg')
    expect(mediaMime('x.gif')).toBe('image/gif')
    expect(mediaMime('x.txt')).toBeUndefined()
  })
})

describe('mediaUrl / pathOfMediaUrl', () => {
  it('round-trips a Windows path with spaces, Hangul and a drive colon', () => {
    const p = 'D:\\ANIPEN\\짧은 영상\\clips\\g1 v2.mp4'
    const url = mediaUrl(p, 1700000000000)
    expect(url.startsWith('astera-media://file/')).toBe(true)
    expect(pathOfMediaUrl(url)).toBe(p)
  })

  it('round-trips a POSIX path', () => {
    expect(pathOfMediaUrl(mediaUrl('/home/a/b c.png'))).toBe('/home/a/b c.png')
  })

  it('carries the version as a query, so a regenerated file is a new URL', () => {
    expect(mediaUrl('/a.png', 1)).not.toBe(mediaUrl('/a.png', 2))
  })

  it('is null for another scheme, another host, or a malformed escape', () => {
    expect(pathOfMediaUrl('file:///a.png')).toBeNull()
    expect(pathOfMediaUrl('astera-media://other/%2Fa.png')).toBeNull()
    expect(pathOfMediaUrl('astera-media://file/%E0%A4%A')).toBeNull()
    expect(pathOfMediaUrl('astera-media://file/')).toBeNull()
  })
})

describe('mediaVersion', () => {
  it('differs when only the size differs, so the URL changes with either', () => {
    expect(mediaVersion({ mtimeMs: 5.7, size: 1 })).not.toBe(mediaVersion({ mtimeMs: 5.7, size: 2 }))
    expect(mediaUrl('/a.mp4', mediaVersion({ mtimeMs: 5, size: 1 }))).not.toBe(mediaUrl('/a.mp4', mediaVersion({ mtimeMs: 6, size: 1 })))
  })
})

describe('resumeAt', () => {
  it('keeps the play position when the new file is still that long', () => {
    expect(resumeAt(12.5, 30)).toBe(12.5)
  })

  it('starts at 0 when the new file is shorter than where playback was', () => {
    expect(resumeAt(12.5, 10)).toBe(0)
    expect(resumeAt(10, 10)).toBe(0)
  })

  it('starts at 0 when either number is not usable', () => {
    expect(resumeAt(Number.NaN, 30)).toBe(0)
    expect(resumeAt(5, Number.NaN)).toBe(0)
    expect(resumeAt(5, Number.POSITIVE_INFINITY)).toBe(5) // a live-like stream with no known end still covers it
  })
})

// A generator that rewrites a clip in place (ffmpeg -y truncates, then writes for seconds) shows a
// different, half-written stat on every poll until it is done. Reloading on each of those flashed
// "cannot open" or a short clip, and the position was lost to the half-written duration. A change is
// therefore loaded only once two checks in a row see the same new stat. Replies are also tagged:
// checks run concurrently (poll, focus, a second click) and an older reply must not win.
describe('reloadStep', () => {
  const st = (mtimeMs: number, size: number): { mtimeMs: number; size: number } => ({ mtimeMs, size })
  const start: ReloadState = { loaded: undefined, pending: undefined, lastSeq: 0 }

  it('the first stat loads at once — there is nothing on screen to keep', () => {
    const r = reloadStep(start, 1, st(1, 10))
    expect(r.action).toBe('reload')
    expect(r.state.loaded).toEqual(st(1, 10))
  })

  it('a size-only change counts, the same as an mtime change', () => {
    let s = reloadStep(start, 1, st(1, 10)).state
    s = reloadStep(s, 2, st(1, 11)).state
    expect(reloadStep(s, 3, st(1, 11)).action).toBe('reload')
  })

  it('the same stat as loaded does nothing', () => {
    const s1 = reloadStep(start, 1, st(1, 10)).state
    expect(reloadStep(s1, 2, st(1, 10)).action).toBe('none')
  })

  it('a file being rewritten reloads once, when two checks agree on the new stat', () => {
    let s = reloadStep(start, 1, st(1, 1000)).state
    const steps: string[] = []
    for (const [seq, next] of [
      [2, st(2, 0)], // truncated
      [3, st(3, 400)], // half written
      [4, st(4, 900)], // still going
      [5, st(5, 1200)], // done
      [6, st(5, 1200)] // and still the same: stable
    ] as const) {
      const r = reloadStep(s, seq, next)
      steps.push(r.action)
      s = r.state
    }
    expect(steps).toEqual(['none', 'none', 'none', 'none', 'reload'])
    expect(s.loaded).toEqual(st(5, 1200))
    expect(s.pending).toBeUndefined()
  })

  it('a change that goes back to what is loaded is no change', () => {
    let s = reloadStep(start, 1, st(1, 10)).state
    s = reloadStep(s, 2, st(2, 5)).state
    const r = reloadStep(s, 3, st(1, 10))
    expect(r.action).toBe('none')
    expect(r.state.pending).toBeUndefined()
  })

  it('a missing file is "gone" only when two checks agree — a delete-then-rewrite does not flash', () => {
    let s = reloadStep(start, 1, st(1, 10)).state
    let r = reloadStep(s, 2, null)
    expect(r.action).toBe('none')
    s = reloadStep(r.state, 3, st(4, 20)).state // it came back, mid-write
    r = reloadStep(s, 4, st(4, 20))
    expect(r.action).toBe('reload')
    r = reloadStep(r.state, 5, null)
    r = reloadStep(r.state, 6, null)
    expect(r.action).toBe('gone')
    expect(r.state.loaded).toBeNull()
  })

  it('a file missing from the first check is gone at once', () => {
    expect(reloadStep(start, 1, null).action).toBe('gone')
  })

  it('a reply older than the newest applied one is dropped, state untouched', () => {
    const s1 = reloadStep(start, 2, st(2, 20)).state // the newer check answered first
    const r = reloadStep(s1, 1, st(1, 10)) // the older one lands late
    expect(r.action).toBe('none')
    expect(r.state).toBe(s1)
    // and a reply with the same sequence number is not applied twice
    expect(reloadStep(s1, 2, st(3, 30)).state).toBe(s1)
  })
})
