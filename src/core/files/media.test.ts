import { describe, it, expect } from 'vitest'
import { mediaKindOf, mediaMime, mediaUrl, pathOfMediaUrl } from './media'

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
