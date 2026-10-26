// The Credentials list's registry (credentials design §4): hide-only entries and per-server hiding in a Host-owned file,
// read as empty when missing and refused when damaged (the damaged bytes kept beside it), and the names nobody may hide.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialsDamaged, isProtectedName, newHideOnlyId, readCredentials, validateHideOnly, writeCredentials } from './store'
import type { CredentialsFile } from './types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-creds-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const FILE: CredentialsFile = {
  version: 1,
  entries: [{ kind: 'hide-only', id: 'hc_1', alias: 'AWS', envNames: ['AWS_ACCESS_KEY_ID'], presets: ['aws'], hide: { on: true }, createdAt: '2026-10-26T00:00:00.000Z' }],
  mcpHide: { mcp1: { on: false } }
}

describe('the credentials registry', () => {
  it('reads an empty list when there is no file', async () => {
    expect(await readCredentials(dir)).toEqual({ version: 1, entries: [], mcpHide: {} })
  })

  it('writes atomically and reads back', async () => {
    await writeCredentials(dir, FILE)
    expect(await readCredentials(dir)).toEqual(FILE)
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('keeps a damaged file aside and refuses to read it', async () => {
    await fs.writeFile(path.join(dir, 'credentials.json'), '{ not json')
    await expect(readCredentials(dir)).rejects.toBeInstanceOf(CredentialsDamaged)
    expect(await fs.readFile(path.join(dir, 'credentials.json.bak'), 'utf8')).toBe('{ not json')
  })

  it('isProtectedName refuses the protected prefixes whatever their case', () => {
    for (const n of ['ASTERA_SESSION', 'claude_config_dir', 'CODEX_HOME', 'Anthropic_Api_Key', 'openai_api_key']) expect(isProtectedName(n), n).toBe(true)
    for (const n of ['GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'MY_OPENAI_KEY']) expect(isProtectedName(n), n).toBe(false)
  })

  it('validateHideOnly refuses a protected name, a bad name, an unknown preset, an empty entry and an empty alias', () => {
    const presets = ['gh', 'aws']
    expect(validateHideOnly({ alias: 'a', envNames: ['STRIPE_KEY'], presets: [] }, presets)).toEqual({ ok: true })
    expect(validateHideOnly({ alias: 'a', envNames: [], presets: ['gh'] }, presets)).toEqual({ ok: true })
    expect(validateHideOnly({ alias: 'a', envNames: ['OPENAI_API_KEY'], presets: [] }, presets)).toEqual({ ok: false, reason: 'protected-name' })
    expect(validateHideOnly({ alias: 'a', envNames: ['A B'], presets: [] }, presets)).toEqual({ ok: false, reason: 'bad-name' })
    expect(validateHideOnly({ alias: 'a', envNames: [], presets: ['az'] }, presets)).toEqual({ ok: false, reason: 'unknown-preset' })
    expect(validateHideOnly({ alias: 'a', envNames: [], presets: [] }, presets)).toEqual({ ok: false, reason: 'empty' })
    expect(validateHideOnly({ alias: '  ', envNames: ['X'], presets: [] }, presets)).toEqual({ ok: false, reason: 'alias-empty' })
  })

  it('makes hide-only ids that differ', () => {
    const a = newHideOnlyId()
    expect(a).toMatch(/^hc_[0-9a-f]{12}$/)
    expect(newHideOnlyId()).not.toBe(a)
  })
})
