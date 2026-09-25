import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readResumeStrategy } from './resumeStrategy'

describe('readResumeStrategy (S6, the Host)', () => {
  it('reads smart, and anything else or nothing as original', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rs-'))
    const f = path.join(dir, 'app-settings.json')
    try {
      expect(await readResumeStrategy(f)).toBe('original')
      await fs.writeFile(f, JSON.stringify({ resumeStrategy: 'smart' }))
      expect(await readResumeStrategy(f)).toBe('smart')
      await fs.writeFile(f, JSON.stringify({ resumeStrategy: 'bold' }))
      expect(await readResumeStrategy(f)).toBe('original')
      await fs.writeFile(f, '{ damaged')
      expect(await readResumeStrategy(f)).toBe('original')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
