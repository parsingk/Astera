// The shared extension and credential findings (lifecycle design §4.5, §4.8, §4.9): an enabled MCP server no session
// called in 30 days of Observe history, a server that passes a session's variable the Credentials list does not name, and
// a stored secret not used in 30 days. Nothing younger than the window is judged (Review Focus 3), and no value is ever
// put in a finding (§8).
import { describe, it, expect } from 'vitest'
import type { CredentialsFile, HideOnlyEntry } from '../../credentials/types'
import type { McpEnvValue, McpExtension, ExtensionEntry } from '../../extensions/types'
import type { FindingInputs } from '../compute'
import { emptyUse } from '../usage'
import type { ObservedUse } from '../types'
import { staleCredentialFindings, unmanagedReferenceFindings, unusedMcpFindings } from './extensions'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

const mcp = (id: string, over: Partial<McpExtension> = {}): McpExtension => ({
  id,
  kind: 'mcp',
  name: id.replace(/^mcp-/, ''),
  transport: 'stdio',
  command: 'x',
  env: {},
  providers: ['claude', 'codex'],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: ago(40),
  ...over
})
const skill = (id: string): ExtensionEntry => ({ id, kind: 'skill', name: id, hash: 'h', providers: ['claude'], importedFrom: 'acc_1', enabled: true, addedAt: ago(40) })
/** The servers sessions called, by the server part of each target. */
const called = (...servers: string[]): ObservedUse => {
  const u = emptyUse()
  for (const s of servers) u.mcpServers.add(s)
  return u
}
const creds = (entries: HideOnlyEntry[] = [], mcpHide: CredentialsFile['mcpHide'] = {}): CredentialsFile => ({ version: 1, entries, mcpHide })
const hideOnly = (id: string, envNames: string[], presets: string[] = []): HideOnlyEntry => ({
  kind: 'hide-only',
  id,
  alias: id,
  envNames,
  presets,
  hide: { on: true },
  createdAt: ago(50)
})
const inputs = (over: Partial<FindingInputs> = {}): FindingInputs => ({
  nowMs: NOW,
  platform: 'linux',
  findingsSince: ago(400),
  policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' },
  observe: { on: true, days: 30 },
  observed: emptyUse(),
  registry: [],
  credentials: creds(),
  credentialLastUse: new Map(),
  ...over
})

describe('unused-mcp (§4.5)', () => {
  it('an enabled shared MCP server, added 40 days ago, never called, is unused-mcp with days 30', () => {
    const found = unusedMcpFindings(inputs({ registry: [mcp('mcp-github'), skill('skill-review')], observed: called('linear') }))
    expect(found).toEqual([
      {
        key: 'unused-mcp:mcp-github',
        rule: 'unused-mcp',
        subject: { kind: 'extension', id: 'mcp-github', name: 'github' },
        profileIds: [],
        message: { key: 'findings.reason.unusedMcp', params: { days: 30 } },
        reason: 'No session called it in 30 days.',
        suggestion: { key: 'findings.do.disableMcp' },
        action: 'Turn it off or remove it.',
        open: { kind: 'extension', entryId: 'mcp-github' },
        ignored: false
      }
    ])
  })

  it('a call from any session counts, exactly named', () => {
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github')], observed: called('github') }))).toEqual([])
  })

  it('called under a normalized name is used', () => {
    // Claude Code names a server's tools with the characters it allows: `my.server` is called as mcp__my_server__…
    const registry = [mcp('mcp-x', { name: 'my.server' })]
    expect(unusedMcpFindings(inputs({ registry, observed: called('my_server') }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry, observed: called('my_other') }))).toHaveLength(1)
  })

  it('added 2 days ago is not judged', () => {
    // Observe has been on for the whole window: the server is younger than it (Review Focus 3)
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(2) })] }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(29) })] }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(30) })] }))).toHaveLength(1)
  })

  it('with 12 days of Observe history nothing is raised', () => {
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github')], observe: { on: true, days: 12 } }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github')], observe: { on: false, days: 0 } }))).toEqual([])
  })

  it('a disabled server is not judged', () => {
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { enabled: false })] }))).toEqual([])
  })

  it('an entry with no addedAt is aged from findingsSince', () => {
    const registry = [mcp('mcp-github', { addedAt: undefined })]
    expect(unusedMcpFindings(inputs({ registry, findingsSince: ago(10) }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry, findingsSince: ago(40) }))).toHaveLength(1)
  })

  // Ruling R4-3: a server switched off for 60 days and on again yesterday had no chance to be called
  it('re-enabled 1 day ago, added 90 days ago: not judged; re-enabled 40 days ago: judged', () => {
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(90), enabledAt: ago(1) })] }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(90), enabledAt: ago(29) })] }))).toEqual([])
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(90), enabledAt: ago(40) })] }))).toHaveLength(1)
    // No addedAt: the later of findingsSince and enabledAt
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: undefined, enabledAt: ago(5) })], findingsSince: ago(90) }))).toEqual([])
    // An enabledAt that does not parse is never taken for old
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: ago(90), enabledAt: 'garbled' })] }))).toEqual([])
  })

  it('an addedAt that does not parse is never taken for old', () => {
    expect(unusedMcpFindings(inputs({ registry: [mcp('mcp-github', { addedAt: 'not a time' })] }))).toEqual([])
  })
})

describe('unmanaged-credential-reference (§4.8)', () => {
  const inherit: McpEnvValue = { inherit: true }

  it('an inherit env KEY not among the Credentials entries’ envNames is raised with that name', () => {
    const registry = [mcp('mcp-linear', { env: { LINEAR_API_KEY: inherit, OTHER_TOKEN: inherit } })]
    const found = unmanagedReferenceFindings(inputs({ registry, credentials: creds([hideOnly('hc_1', ['OTHER_TOKEN'])]) }))
    expect(found).toEqual([
      {
        key: 'unmanaged-credential-reference:mcp-linear',
        rule: 'unmanaged-credential-reference',
        subject: { kind: 'extension', id: 'mcp-linear', name: 'linear' },
        profileIds: [],
        message: { key: 'findings.reason.unmanagedReference', params: { names: 'LINEAR_API_KEY' } },
        reason: 'Passes LINEAR_API_KEY from the session, which the Credentials list does not name.',
        suggestion: { key: 'findings.do.addCredential' },
        action: 'Add it to the Credentials list, or store it with the server.',
        open: { kind: 'extension', entryId: 'mcp-linear' },
        ignored: false
      }
    ])
  })

  it('names every unnamed variable of one server in one finding, and judges disabled servers too', () => {
    const registry = [mcp('mcp-linear', { enabled: false, env: { A_KEY: inherit, B_KEY: inherit } })]
    const found = unmanagedReferenceFindings(inputs({ registry }))
    expect(found.map((f) => f.message.params)).toEqual([{ names: 'A_KEY, B_KEY' }])
  })

  it('the same name in a hide-only entry or an MCP secret entry is not', () => {
    const registry = [
      mcp('mcp-linear', { env: { HIDDEN_KEY: inherit, SECRET_KEY: inherit } }),
      // Another server keeps a stored secret under SECRET_KEY: the list names it as that server's entry
      mcp('mcp-store', { env: { SECRET_KEY: { secret: 'mcp.mcp-store.SECRET_KEY' } } })
    ]
    expect(unmanagedReferenceFindings(inputs({ registry, credentials: creds([hideOnly('hc_1', ['HIDDEN_KEY'])]) }))).toEqual([])
  })

  it('a name a preset of a hide-only entry removes or redirects is known', () => {
    const registry = [mcp('mcp-gh', { env: { GH_TOKEN: inherit, GH_CONFIG_DIR: inherit, AWS_PROFILE: inherit } })]
    const found = unmanagedReferenceFindings(inputs({ registry, credentials: creds([hideOnly('hc_1', [], ['gh'])]) }))
    // gh removes GH_TOKEN and redirects GH_CONFIG_DIR; AWS_PROFILE is the aws preset's, which no entry names
    expect(found.map((f) => f.message.params)).toEqual([{ names: 'AWS_PROFILE' }])
  })

  it('names compare as the session’s environment does: whatever their case on win32, exactly elsewhere', () => {
    const registry = [mcp('mcp-linear', { env: { LINEAR_API_KEY: inherit } })]
    const credentials = creds([hideOnly('hc_1', ['linear_api_key'])])
    expect(unmanagedReferenceFindings(inputs({ registry, credentials, platform: 'win32' }))).toEqual([])
    expect(unmanagedReferenceFindings(inputs({ registry, credentials, platform: 'linux' }))).toHaveLength(1)
    expect(unmanagedReferenceFindings(inputs({ registry, credentials, platform: 'darwin' }))).toHaveLength(1)
  })

  it('PATH and other never-hidden names are not', () => {
    const registry = [mcp('mcp-x', { env: { PATH: inherit, HOME: inherit, SYSTEMROOT: inherit } })]
    expect(unmanagedReferenceFindings(inputs({ registry }))).toEqual([])
  })

  it('values are never put in the message', () => {
    const VALUE = 'plain-value-that-must-not-leave-the-registry'
    const registry = [mcp('mcp-linear', { env: { LINEAR_API_KEY: inherit, LOG_LEVEL: { value: VALUE } } })]
    const found = unmanagedReferenceFindings(inputs({ registry }))
    expect(found).toHaveLength(1)
    expect(JSON.stringify(found)).not.toContain(VALUE)
    expect(JSON.stringify(found)).not.toContain('LOG_LEVEL')
  })
})

describe('stale-credential (§4.9)', () => {
  const withSecret = (id: string, over: Partial<McpExtension> = {}): McpExtension =>
    mcp(id, { env: { API_KEY: { secret: `mcp.${id}.API_KEY` } }, ...over })

  it('an MCP secret entry with no use in 30 days, its server added 40 days ago and findingsSince 40 days ago, is stale-credential', () => {
    const found = staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear')], findingsSince: ago(40) }))
    expect(found).toEqual([
      {
        key: 'stale-credential:mcp:mcp-linear',
        rule: 'stale-credential',
        subject: { kind: 'credential', id: 'mcp:mcp-linear', name: 'linear' },
        profileIds: [],
        message: { key: 'findings.reason.staleCredential', params: { days: 30 } },
        reason: 'Its stored secret was not used in 30 days.',
        suggestion: { key: 'findings.do.removeSecret' },
        action: 'Remove the stored value, or the server.',
        open: { kind: 'credentials', entryId: 'mcp:mcp-linear' },
        ignored: false
      }
    ])
  })

  it('findingsSince 10 days ago: not judged', () => {
    expect(staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear')], findingsSince: ago(10) }))).toEqual([])
  })

  it('a server added 10 days ago: not judged', () => {
    expect(staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear', { addedAt: ago(10) })], findingsSince: ago(40) }))).toEqual([])
    // No addedAt: aged from findingsSince
    expect(staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear', { addedAt: undefined })], findingsSince: ago(40) }))).toHaveLength(1)
  })

  it('a server switched on again 10 days ago: not judged; 40 days ago: judged (ruling R4-3)', () => {
    const at = (enabledAt: string) => staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear', { addedAt: ago(90), enabledAt })], findingsSince: ago(90) }))
    expect(at(ago(10))).toEqual([])
    expect(at(ago(40))).toHaveLength(1)
  })

  it('a use 3 days ago: not raised', () => {
    const credentialLastUse = new Map([['mcp:mcp-linear', ago(3)]])
    expect(staleCredentialFindings(inputs({ registry: [withSecret('mcp-linear')], findingsSince: ago(40), credentialLastUse }))).toEqual([])
  })

  it('hide-only entries are never judged', () => {
    // A server with no stored secret has no entry of its own, and a hide-only entry has no use signal
    const registry = [mcp('mcp-plain', { env: { LOG_LEVEL: { value: 'info' } } })]
    const credentials = creds([hideOnly('hc_1', ['GH_TOKEN'], ['gh'])])
    expect(staleCredentialFindings(inputs({ registry, credentials, findingsSince: ago(400) }))).toEqual([])
  })
})
