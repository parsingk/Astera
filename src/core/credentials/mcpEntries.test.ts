// The automatic entries of the Credentials list (credentials design §4, C7): one per shared MCP server that holds a stored
// secret, with the variable names its secrets use, hidden from agent sessions unless the person switched it off.
import { describe, it, expect } from 'vitest'
import { mcpSecretEntries } from './mcpEntries'
import type { ExtensionRegistry, McpExtension } from '../extensions/types'

const mcp = (id: string, env: McpExtension['env']): McpExtension => ({
  id,
  kind: 'mcp',
  name: `server-${id}`,
  transport: 'stdio',
  command: 'npx',
  env,
  providers: ['claude', 'codex'],
  importedFrom: 'acc1',
  enabled: true
})

const registry = (...entries: McpExtension[]): ExtensionRegistry => ({ version: 1, entries })

describe('mcpSecretEntries', () => {
  it('lists a shared server with a stored secret, its variable names, hidden by default', () => {
    const r = registry(mcp('m1', { GITHUB_TOKEN: { secret: 'm1-github' }, LOG_LEVEL: { value: 'info' } }))
    expect(mcpSecretEntries(r, {})).toEqual([
      { kind: 'mcp-secret', id: 'mcp:m1', serverId: 'm1', serverName: 'server-m1', secretNames: ['m1-github'], envNames: ['GITHUB_TOKEN'], protectedNames: [], hide: { on: true } }
    ])
  })

  it('leaves out a server with no stored secret', () => {
    expect(mcpSecretEntries(registry(mcp('m2', { LOG_LEVEL: { value: 'info' }, HOME: { inherit: true } })), {})).toEqual([])
  })

  it('applies the saved hiding of a server', () => {
    const r = registry(mcp('m1', { API_KEY: { secret: 's' } }))
    expect(mcpSecretEntries(r, { m1: { on: false } })[0].hide).toEqual({ on: false })
    expect(mcpSecretEntries(r, { m1: { on: true, projects: ['D:/p'] } })[0].hide).toEqual({ on: true, projects: ['D:/p'] })
  })

  it('keeps a protected variable name out of the hiding and lists it apart', () => {
    const r = registry(mcp('m1', { OPENAI_API_KEY: { secret: 'o' }, SERP_KEY: { secret: 's' } }))
    const [e] = mcpSecretEntries(r, {})
    expect(e.envNames).toEqual(['SERP_KEY'])
    expect(e.protectedNames).toEqual(['OPENAI_API_KEY'])
    expect(e.secretNames).toEqual(['o', 's'])
  })
})
