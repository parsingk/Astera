import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostRollingLog } from './rollingLog'

describe('hostRollingLog (S6 R10)', () => {
  it('appends prefixed lines to the profile’s rolling.log', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rlog-'))
    try {
      hostRollingLog(dir, '[host]')('rolled s1 -> s2')
      hostRollingLog(dir, '[host][codex]')('rolled c1 -> c2')
      const text = await fs.readFile(path.join(dir, 'rolling.log'), 'utf8')
      expect(text).toMatch(/Z \[host\] rolled s1 -> s2\n/)
      expect(text).toMatch(/Z \[host\]\[codex\] rolled c1 -> c2\n/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('never throws, even when the folder is gone', () => {
    expect(() => hostRollingLog(path.join(os.tmpdir(), 'astera-no-such', 'x'), '[host]')('x')).not.toThrow()
  })
})
