import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpSessionsOf, readMcpSessions } from './mcpSessions'

describe('mcpSessionsOf', () => {
  it('is true only for true; anything else is false', () => {
    expect(mcpSessionsOf(true)).toBe(true)
    expect(mcpSessionsOf(false)).toBe(false)
    expect(mcpSessionsOf(undefined)).toBe(false)
    expect(mcpSessionsOf('true')).toBe(false)
    expect(mcpSessionsOf(1)).toBe(false)
  })
})

describe('readMcpSessions', () => {
  const file = async (text: string | null): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-sessions-'))
    const p = path.join(dir, 'app-settings.json')
    if (text !== null) await fs.writeFile(p, text)
    return p
  }
  it('a missing file is false', async () => {
    expect(await readMcpSessions(await file(null))).toBe(false)
  })
  it('reads the stored value', async () => {
    expect(await readMcpSessions(await file('{"mcpSessions":true}'))).toBe(true)
  })
  it('an unreadable settings file refuses: it throws rather than answering false', async () => {
    await expect(readMcpSessions(await file('{not json'))).rejects.toThrow()
  })
})
