import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeDescriptors } from '../providers/descriptor'
import { isLoggedIn } from './loginCheck'

describe('isLoggedIn (C8)', () => {
  it('answers by the provider’s own probe: a codex auth.json is a login, a bare folder is not', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-login-'))
    const d = makeDescriptors(process.platform)
    const acc = { id: 'x', label: 'x', configDir: dir, color: '#000', createdAt: '2026-09-24T00:00:00.000Z', provider: 'codex' as const }
    expect(await isLoggedIn(acc, d)).toBe(false)
    await fs.writeFile(path.join(dir, 'auth.json'), '{}')
    expect(await isLoggedIn(acc, d)).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
