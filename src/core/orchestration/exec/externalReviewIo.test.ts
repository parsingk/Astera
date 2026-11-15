// The external review's transcripts live in their own folder with their own retention (final fix wave C1): older than 14
// days, or beyond the 200 newest, goes; a prune never throws.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { externalReviewIo, REVIEW_LOG_KEEP, REVIEW_LOG_MAX_AGE_MS } from './externalReviewIo'
import { removeFixture } from '../../testFixtures'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const tempDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-reviewlogs-'))
  dirs.push(d)
  return d
}
const DAY = 24 * 60 * 60_000
const touch = (dir: string, name: string, ageMs: number): void => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, 'x')
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(p, t, t)
}

describe('pruneReviewLogs', () => {
  it('keeps 14 days and 200 files', () => {
    expect(REVIEW_LOG_MAX_AGE_MS).toBe(14 * DAY)
    expect(REVIEW_LOG_KEEP).toBe(200)
  })

  it('removes a transcript older than 14 days and keeps a fresh one', () => {
    const dir = tempDir()
    touch(dir, 'old.log', 15 * DAY)
    touch(dir, 'fresh.log', 60_000)
    externalReviewIo(() => {}).pruneReviewLogs(dir)
    expect(fs.readdirSync(dir)).toEqual(['fresh.log'])
  })

  it('beyond the 200 newest, removes the oldest', () => {
    const dir = tempDir()
    for (let i = 0; i < 203; i++) touch(dir, `t${String(i).padStart(3, '0')}.log`, (i + 1) * 60_000)
    externalReviewIo(() => {}).pruneReviewLogs(dir)
    const left = fs.readdirSync(dir).sort()
    expect(left).toHaveLength(200)
    // t000 is the newest, t202 the oldest
    expect(left).not.toContain('t200.log')
    expect(left).not.toContain('t202.log')
    expect(left).toContain('t199.log')
  })

  it('never throws, and logs what it could not do', () => {
    const logs: string[] = []
    const missing = path.join(tempDir(), 'not-there')
    expect(() => externalReviewIo((m) => logs.push(m)).pruneReviewLogs(missing)).not.toThrow()
    // a folder that does not exist yet has nothing to prune and is not a failure
    expect(logs).toEqual([])
    const file = path.join(tempDir(), 'a-file')
    fs.writeFileSync(file, 'x')
    expect(() => externalReviewIo((m) => logs.push(m)).pruneReviewLogs(file)).not.toThrow()
    expect(logs.join('\n')).toMatch(/review transcripts could not be pruned/)
  })
})
