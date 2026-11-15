import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EMPTY_SLACK_CONFIG, SlackConfigReader } from './config'

describe('SlackConfigReader runReports', () => {
  it('is on for a file without the field, a missing file, and off only for false', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-rr-'))
    try {
      const file = path.join(dir, 'slack.json')
      const reader = new SlackConfigReader(file)
      expect((await reader.load()).runReports).toBe(true) // missing file
      await fs.writeFile(file, JSON.stringify({ botToken: 'xoxb-1', channelId: 'C1' }), 'utf8')
      expect((await reader.load()).runReports).toBe(true)
      await fs.writeFile(file, JSON.stringify({ runReports: false }), 'utf8')
      expect((await reader.load()).runReports).toBe(false)
      await fs.writeFile(file, JSON.stringify({ runReports: true }), 'utf8')
      expect((await reader.load()).runReports).toBe(true)
      expect(EMPTY_SLACK_CONFIG.runReports).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
