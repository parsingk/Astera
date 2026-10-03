import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpAccessOf, readMcpAccess } from './mcpAccess'

describe('mcpAccessOf', () => {
  it('keeps the three values and reads anything else as control (design M6)', () => {
    expect(mcpAccessOf('off')).toBe('off')
    expect(mcpAccessOf('read')).toBe('read')
    expect(mcpAccessOf('control')).toBe('control')
    expect(mcpAccessOf(undefined)).toBe('control')
    expect(mcpAccessOf('everything')).toBe('control')
  })
})

describe('readMcpAccess', () => {
  const file = async (text: string | null): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-access-'))
    const p = path.join(dir, 'app-settings.json')
    if (text !== null) await fs.writeFile(p, text)
    return p
  }
  it('a missing file is control', async () => {
    expect(await readMcpAccess(await file(null))).toBe('control')
  })
  it('reads the stored value', async () => {
    expect(await readMcpAccess(await file('{"mcpAccess":"read"}'))).toBe('read')
  })
  it('an unreadable settings file refuses: it throws rather than answering control', async () => {
    await expect(readMcpAccess(await file('{not json'))).rejects.toThrow()
  })
})
