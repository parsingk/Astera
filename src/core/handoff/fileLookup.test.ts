import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lookupHandoffFile } from './fileLookup'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-handoff-lookup-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const file = (): string => path.join(dir, 'handoff.json')

describe('lookupHandoffFile (P12)', () => {
  it('answers found, none and unknown the way HandoffStore.lookup does', async () => {
    expect(lookupHandoffFile(file(), 's-1')).toEqual({ state: 'none' })
    await fs.writeFile(file(), JSON.stringify({ version: 1, memos: { 's-1': { sessionId: 's-1', createdAt: 'x' } } }))
    expect(lookupHandoffFile(file(), 's-1').state).toBe('found')
    expect(lookupHandoffFile(file(), 's-2')).toEqual({ state: 'none' })
    await fs.writeFile(file(), '{ not json')
    expect(lookupHandoffFile(file(), 's-1')).toEqual({ state: 'unknown' })
    await fs.writeFile(file(), JSON.stringify({ version: 2, memos: {} }))
    expect(lookupHandoffFile(file(), 's-1')).toEqual({ state: 'unknown' })
  })
})
