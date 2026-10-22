// Agent Profiles (design §5): the capability cache holds one result per account and profile, so a session started from a
// profile and one started without it on the same account never read each other's servers.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { writeAgentProfiles } from '../agentProfiles/store'
import { writeExtensionRegistry } from './registry'
import { createCapabilityCache } from './capabilityCache'
import type { Account } from '../types'
import type { McpExtension } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-capcache-'))
  dirs.push(d)
  return d
}
const docs: McpExtension = {
  id: 'mcp-docs', kind: 'mcp', name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', env: {},
  providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true
}

describe('createCapabilityCache', () => {
  it('keeps a profile’s result apart from the same account’s result without one', async () => {
    const home = await temp()
    const profileDir = await temp()
    await writeExtensionRegistry(profileDir, { version: 1, entries: [docs] })
    await writeAgentProfiles(profileDir, {
      version: 1,
      profiles: [{
        id: 'ap_000000000001', name: 'P', status: 'active', accountIds: ['acc_3'], mcpExclude: ['mcp-docs'], permission: 'inherit',
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z'
      }]
    })
    const account: Account = { id: 'acc_3', label: 'c', configDir: path.join(home, '.codex-accounts', 'c'), color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider: 'codex' }
    const cache = createCapabilityCache({ profileDir, homeDir: home, platform: 'linux' })
    await cache.refresh(account)
    await cache.refresh(account, 'ap_000000000001')
    expect(cache.get(account)?.given).toEqual(['docs'])
    expect(cache.get(account)?.context.kind).toBe('implicit')
    expect(cache.get(account, 'ap_000000000001')?.given).toEqual([])
    expect(cache.get(account, 'ap_000000000001')?.context.kind).toBe('explicit')
    // Refreshing one does not touch the other
    await cache.refresh(account)
    expect(cache.get(account, 'ap_000000000001')?.given).toEqual([])
    expect(cache.get(account, 'ap_other')).toBeNull()
  })
})
