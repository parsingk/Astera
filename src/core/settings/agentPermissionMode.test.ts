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
  it('is the store default when a valid file does not name the field', async () => {
    await fs.writeFile(file(), JSON.stringify({ theme: 'dark' }))
    expect(await readAgentPermissionMode(file())).toBe('yolo')
  })
  // The same answer AppSettingsStore.load gives for a value it does not know.
  it('is yolo for a value the store does not know, as load reads it', async () => {
    await fs.writeFile(file(), JSON.stringify({ agentPermissionMode: 'MANUAL' }))
    expect(await readAgentPermissionMode(file())).toBe('yolo')
  })
  // A broken file must not read as 'yolo': it may have said 'manual', and answering the bypass
  // would start the Host's workers with permissions off. Only a missing file is D12's default.
  it('throws for a file that is not JSON', async () => {
    await fs.writeFile(file(), '{not json')
    await expect(readAgentPermissionMode(file())).rejects.toThrow(/open Astera to repair it/)
  })
  it('throws for JSON that is not an object', async () => {
    await fs.writeFile(file(), '["manual"]')
    await expect(readAgentPermissionMode(file())).rejects.toThrow(/open Astera to repair it/)
    await fs.writeFile(file(), 'null')
    await expect(readAgentPermissionMode(file())).rejects.toThrow(/open Astera to repair it/)
  })
  it('throws for a file that cannot be read', async () => {
    await fs.mkdir(file())
    await expect(readAgentPermissionMode(file())).rejects.toThrow(/could not be read.*open Astera to repair it/)
  })
  it('throws for a file cut off mid-write', async () => {
    await fs.writeFile(file(), '{"agentPermissionMode": "man')
    await expect(readAgentPermissionMode(file())).rejects.toThrow(/open Astera to repair it/)
  })
  it('narrows a raw value the way the store does', () => {
    expect(agentPermissionModeOf('manual')).toBe('manual')
    expect(agentPermissionModeOf(undefined)).toBe('yolo')
  })
})
