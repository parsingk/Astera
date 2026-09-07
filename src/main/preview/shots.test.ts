import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { previewShotsDir, savePng } from './shots'

let dir: string
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

const image = (w: number, h: number) => ({ getSize: () => ({ width: w, height: h }), toPNG: () => Buffer.from(`png ${w}x${h}`) })

describe('shots', () => {
  it('previewShotsDir is userData/preview/shots', () => {
    expect(previewShotsDir('/u')).toBe(path.join('/u', 'preview', 'shots'))
  })

  it('writes the PNG into the folder, creating it, and reports its size and path', async () => {
    dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'astera-shots-')), 'nested')
    const r = await savePng(image(640, 480), dir)
    expect(r).not.toBeNull()
    expect(r!.width).toBe(640)
    expect(r!.height).toBe(480)
    expect(path.dirname(r!.path)).toBe(dir)
    expect(r!.path.endsWith('.png')).toBe(true)
    expect((await fs.readFile(r!.path)).toString()).toBe('png 640x480')
  })

  it('an empty image is not written and is null', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-shots-'))
    expect(await savePng(image(0, 100), dir)).toBeNull()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('applies the eviction rule after writing', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-shots-'))
    const old = path.join(dir, 'old.png')
    await fs.writeFile(old, 'x')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(old, eightDaysAgo, eightDaysAgo)
    await savePng(image(10, 10), dir)
    // Eviction is fire-and-forget, so it lands some time after savePng resolves. Polled for rather
    // than slept on: a fixed 50 ms is a bet on the machine not being busy, and losing that bet fails
    // a test about eviction for a reason that has nothing to do with eviction.
    const deadline = Date.now() + 5_000
    let left = await fs.readdir(dir)
    while (left.includes('old.png') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
      left = await fs.readdir(dir)
    }
    expect(left).not.toContain('old.png')
    expect(left.filter((n) => n.endsWith('.png'))).toHaveLength(1)
  })
})
