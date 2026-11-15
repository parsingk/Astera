import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EMPTY_REVIEWER_SETTINGS,
  MAX_EXTERNAL_REVIEWERS,
  REVIEWER_PRESETS,
  chosenReviewer,
  newExternalReviewerId,
  reviewerSettingsOf
} from './externalReviewers'
import { readReviewerSettings } from './externalReviewersFile'
import { RepairNeeded } from './repairNeeded'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-extrev-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const file = (): string => path.join(dir, 'app-settings.json')

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ext_0123abcd',
  name: 'Gemini CLI',
  command: 'gemini',
  args: ['--acp'],
  ...over
})
const of = (externalReviewers: unknown, reviewBy?: unknown): ReturnType<typeof reviewerSettingsOf> =>
  reviewerSettingsOf({ externalReviewers, reviewBy })

describe('reviewerSettingsOf', () => {
  it('is empty for a missing object, missing fields or the wrong shapes', () => {
    expect(reviewerSettingsOf(null)).toEqual(EMPTY_REVIEWER_SETTINGS)
    expect(reviewerSettingsOf({})).toEqual({ reviewers: [], reviewBy: null })
    expect(of({ not: 'an array' }, 'ext_0123abcd')).toEqual({ reviewers: [], reviewBy: null })
    expect(of('x')).toEqual(EMPTY_REVIEWER_SETTINGS)
  })
  it('keeps a valid entry and the choice of it', () => {
    expect(of([entry()], 'ext_0123abcd')).toEqual({
      reviewers: [{ id: 'ext_0123abcd', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }],
      reviewBy: 'ext_0123abcd'
    })
  })
  it('trims name and command', () => {
    expect(of([entry({ name: '  Gem  ', command: ' gemini ' })]).reviewers[0]).toMatchObject({ name: 'Gem', command: 'gemini' })
  })
  it('drops an entry that is not an object', () => {
    expect(of([null, 'x', 3, [], entry()]).reviewers).toHaveLength(1)
  })
  it('drops an id that is not ext_ + 8 lowercase hex', () => {
    for (const id of ['ext_0123ABCD', 'ext_0123abc', 'ext_0123abcde', 'x_0123abcd', 5, undefined])
      expect(of([entry({ id })]).reviewers).toEqual([])
  })
  it('drops a name that is empty, over 40, or has a line break; keeps exactly 40', () => {
    for (const name of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\rb', 7])
      expect(of([entry({ name })]).reviewers).toEqual([])
    expect(of([entry({ name: 'x'.repeat(40) })]).reviewers).toHaveLength(1)
  })
  it('drops a command that is empty or has a line break', () => {
    for (const command of ['', '  ', 'a\nb', 'a\rb', null])
      expect(of([entry({ command })]).reviewers).toEqual([])
  })
  // Final fix wave A2: a relative path would run a program from the reviewed folder
  it('drops a command that is a relative path; keeps a bare name and an absolute path', () => {
    const bs = String.fromCharCode(92)
    for (const command of ['./agent', `.${bs}agent`, `bin${bs}agent`, 'bin/agent', '../agent'])
      expect(of([entry({ command })]).reviewers).toEqual([])
    for (const command of ['gemini', 'gemini.cmd', '/usr/local/bin/gemini', `C:${bs}npm${bs}gemini.cmd`, 'C:/npm/gemini', `${bs}${bs}server${bs}share${bs}agent.exe`])
      expect(of([entry({ command })]).reviewers).toHaveLength(1)
  })
  it('drops args that are not strings or are more than 20; keeps exactly 20', () => {
    expect(of([entry({ args: 'x' })]).reviewers).toEqual([])
    expect(of([entry({ args: ['a', 1] })]).reviewers).toEqual([])
    expect(of([entry({ args: undefined })]).reviewers).toEqual([])
    expect(of([entry({ args: Array.from({ length: 21 }, () => 'a') })]).reviewers).toEqual([])
    expect(of([entry({ args: Array.from({ length: 20 }, () => 'a') })]).reviewers).toHaveLength(1)
    expect(of([entry({ args: [] })]).reviewers).toHaveLength(1)
  })
  it('keeps the first of a duplicate id', () => {
    const r = of([entry({ name: 'First' }), entry({ name: 'Second' })]).reviewers
    expect(r.map((x) => x.name)).toEqual(['First'])
  })
  it('keeps at most 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({ id: `ext_${i.toString(16).padStart(8, '0')}` }))
    expect(MAX_EXTERNAL_REVIEWERS).toBe(10)
    expect(of(many).reviewers).toHaveLength(10)
  })
  it('reads reviewBy as null when it names no registered reviewer', () => {
    expect(of([entry()], 'ext_ffffffff').reviewBy).toBeNull()
    expect(of([entry()], 5).reviewBy).toBeNull()
    expect(of([], 'ext_0123abcd').reviewBy).toBeNull()
  })

  // Review Focus 5: three hand-edited files, none of which may throw.
  it('a reviewBy naming a removed reviewer reads as automatic', () => {
    expect(() => of([entry({ id: 'ext_11111111' })], 'ext_22222222')).not.toThrow()
    expect(of([entry({ id: 'ext_11111111' })], 'ext_22222222').reviewBy).toBeNull()
  })
  it('an entry with a multi-line name or 30 args is dropped, the rest survive', () => {
    const s = of([entry({ id: 'ext_aaaaaaaa', name: 'two\nlines' }), entry({ id: 'ext_bbbbbbbb', args: new Array(30).fill('a') }), entry({ id: 'ext_cccccccc' })], 'ext_aaaaaaaa')
    expect(s.reviewers.map((r) => r.id)).toEqual(['ext_cccccccc'])
    expect(s.reviewBy).toBeNull()
  })
  it('an array where an object is expected reads as empty', () => {
    expect(reviewerSettingsOf([] as unknown as Record<string, unknown>)).toEqual(EMPTY_REVIEWER_SETTINGS)
    expect(of([[entry()]]).reviewers).toEqual([])
  })
})

describe('helpers', () => {
  it('newExternalReviewerId is ext_ + 8 hex and differs between calls', () => {
    const a = newExternalReviewerId()
    expect(a).toMatch(/^ext_[0-9a-f]{8}$/)
    expect(newExternalReviewerId()).not.toBe(a)
  })
  it('chosenReviewer is the registered one reviewBy names, else null', () => {
    const s = of([entry()], 'ext_0123abcd')
    expect(chosenReviewer(s)?.command).toBe('gemini')
    expect(chosenReviewer(EMPTY_REVIEWER_SETTINGS)).toBeNull()
    expect(chosenReviewer({ reviewers: s.reviewers, reviewBy: null })).toBeNull()
  })
  it('presets are exact', () => {
    expect(REVIEWER_PRESETS).toEqual([
      { key: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
      { key: 'copilot', name: 'Copilot CLI', command: 'copilot', args: ['--acp'] },
      { key: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] }
    ])
  })
})

describe('readReviewerSettings', () => {
  it('is empty when there is no settings file', async () => {
    expect(await readReviewerSettings(file())).toEqual(EMPTY_REVIEWER_SETTINGS)
  })
  it('narrows a valid file', async () => {
    await fs.writeFile(file(), JSON.stringify({ externalReviewers: [entry()], reviewBy: 'ext_0123abcd' }))
    expect((await readReviewerSettings(file())).reviewBy).toBe('ext_0123abcd')
  })
  it('is empty for a valid file that does not name the fields', async () => {
    await fs.writeFile(file(), JSON.stringify({ theme: 'dark' }))
    expect(await readReviewerSettings(file())).toEqual(EMPTY_REVIEWER_SETTINGS)
  })
  it('throws RepairNeeded for a file holding an array', async () => {
    await fs.writeFile(file(), '[]')
    const err = await readReviewerSettings(file()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect((err as RepairNeeded).file).toBe('app-settings.json')
  })
  it('throws RepairNeeded for a file that is not JSON or cannot be read', async () => {
    await fs.writeFile(file(), '{not json')
    await expect(readReviewerSettings(file())).rejects.toBeInstanceOf(RepairNeeded)
    await fs.rm(file())
    await fs.mkdir(file())
    await expect(readReviewerSettings(file())).rejects.toThrow(/could not be read/)
  })
})
