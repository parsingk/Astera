import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readContinuitySettings } from './continuitySettings'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-continuity-settings-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const at = (): string => path.join(dir, 'app-settings.json')

describe('readContinuitySettings (P7)', () => {
  it('reads the toggle and Smart Resume the way the app store narrows them', async () => {
    await fs.writeFile(at(), JSON.stringify({ jobContinuityEnabled: true, resumeStrategy: 'smart' }))
    expect(await readContinuitySettings(at())).toEqual({ enabled: true, smartResume: true })
    await fs.writeFile(at(), JSON.stringify({ jobContinuityEnabled: 'yes', resumeStrategy: 'original' }))
    expect(await readContinuitySettings(at())).toEqual({ enabled: false, smartResume: false })
  })
  it('a missing or damaged file is off: nothing is journaled on a guess', async () => {
    expect(await readContinuitySettings(at())).toEqual({ enabled: false, smartResume: false })
    await fs.writeFile(at(), '{ not json')
    expect(await readContinuitySettings(at())).toEqual({ enabled: false, smartResume: false })
  })
})
