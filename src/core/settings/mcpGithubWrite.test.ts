import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpGithubWriteOf, readMcpGithubWrite } from './mcpGithubWrite'

describe('mcpGithubWriteOf', () => {
  it('is true only for true; anything else is false', () => {
    expect(mcpGithubWriteOf(true)).toBe(true)
    expect(mcpGithubWriteOf(false)).toBe(false)
    expect(mcpGithubWriteOf(undefined)).toBe(false)
    expect(mcpGithubWriteOf('true')).toBe(false)
    expect(mcpGithubWriteOf(1)).toBe(false)
  })
})

describe('readMcpGithubWrite', () => {
  const file = async (text: string | null): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-github-write-'))
    const p = path.join(dir, 'app-settings.json')
    if (text !== null) await fs.writeFile(p, text)
    return p
  }
  it('a missing file is false', async () => {
    expect(await readMcpGithubWrite(await file(null))).toBe(false)
  })
  it('reads the stored value', async () => {
    expect(await readMcpGithubWrite(await file('{"mcpGithubWrite":true}'))).toBe(true)
  })
  it('an unreadable settings file refuses: it throws rather than answering false', async () => {
    await expect(readMcpGithubWrite(await file('{not json'))).rejects.toThrow()
  })
})
