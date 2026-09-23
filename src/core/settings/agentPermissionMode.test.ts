import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentPermissionModeOf, readAgentPermissionMode } from './agentPermissionMode'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-perm-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const file = (): string => path.join(dir, 'app-settings.json')

describe('readAgentPermissionMode (D12)', () => {
  it('is yolo when there is no settings file', async () => {
    expect(await readAgentPermissionMode(file())).toBe('yolo')
  })
  it('is manual only when the file says manual', async () => {
    await fs.writeFile(file(), JSON.stringify({ agentPermissionMode: 'manual' }))
    expect(await readAgentPermissionMode(file())).toBe('manual')
  })
  it('is yolo for any other value and for a file that is not JSON', async () => {
    await fs.writeFile(file(), JSON.stringify({ agentPermissionMode: 'MANUAL' }))
    expect(await readAgentPermissionMode(file())).toBe('yolo')
    await fs.writeFile(file(), '{not json')
    expect(await readAgentPermissionMode(file())).toBe('yolo')
  })
  it('narrows a raw value the way the store does', () => {
    expect(agentPermissionModeOf('manual')).toBe('manual')
    expect(agentPermissionModeOf(undefined)).toBe('yolo')
  })
})
