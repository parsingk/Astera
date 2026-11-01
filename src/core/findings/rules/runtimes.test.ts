// stale-runtime (lifecycle design §4.7): a paired Remote Runtime this machine has not reached in more than 30 days, or
// never reached in the 30 days since it was paired. runtime-missing-extension and outdated-runtime (remote governance
// design §9.2, §9.3): read from what the registry kept, never from the Runtime itself.
import { describe, it, expect } from 'vitest'
import type { RuntimeProfile } from '../../runtimes/registry'
import type { ControlPlaneReport, ReportExtension } from '../../controlPlane/report'
import type { FindingInputs } from '../compute'
import { outdatedRuntimeFindings, runtimeExtensionFindings, runtimeExtensionInfo, staleRuntimeFindings } from './runtimes'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

const runtime = (runtimeId: string, over: Partial<RuntimeProfile> = {}): RuntimeProfile => ({
  runtimeId,
  name: `box ${runtimeId}`,
  address: '10.0.0.2',
  port: 7420,
  fingerprint: 'sha256/abc',
  permission: 'read-only',
  createdAt: ago(100),
  lastSeenAt: ago(1),
  ...over
})
const inputs = (runtimes: RuntimeProfile[]): FindingInputs => ({ nowMs: NOW, platform: 'linux', findingsSince: ago(400), runtimes })

describe('stale-runtime (§4.7)', () => {
  it('lastSeenAt 31 days ago is stale-runtime', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(31) })]))).toEqual([
      {
        key: 'stale-runtime:rt_a',
        rule: 'stale-runtime',
        subject: { kind: 'runtime', id: 'rt_a', name: 'box rt_a' },
        profileIds: [],
        message: { key: 'findings.reason.staleRuntime', params: { days: 31 } },
        reason: 'Not reached in 31 days.',
        suggestion: { key: 'findings.do.removePairing' },
        action: 'Remove the pairing.',
        open: { kind: 'runtimes', runtimeId: 'rt_a' },
        ignored: false
      }
    ])
  })

  it('null lastSeenAt and createdAt 31 days ago is stale-runtime (never reached)', () => {
    const found = staleRuntimeFindings(inputs([runtime('rt_b', { lastSeenAt: null, createdAt: ago(31) })]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      key: 'stale-runtime:rt_b',
      message: { key: 'findings.reason.staleRuntimeNever', params: { days: 31 } },
      reason: 'Never reached since it was paired 31 days ago.'
    })
  })

  it('29 days is not', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(29) }), runtime('rt_b', { lastSeenAt: null, createdAt: ago(29) })]))).toEqual([])
    // Exactly 30 days is not more than 30
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(30) })]))).toEqual([])
  })

  it('a time that does not parse is never taken for old', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: 'garbled' }), runtime('rt_b', { lastSeenAt: null, createdAt: '' })]))).toEqual([])
  })
})

// The end-to-end case over what the app saves (remote governance design §9.1) is in src/main/remote/runtimes.test.ts.

const READ_AT = ago(2)
const hash = (c: string): string => 'cmp1:sha256:' + c.repeat(64)
const ext = (id: string, kind: ReportExtension['kind'] = 'skill', more: Partial<ReportExtension> = {}): ReportExtension => ({
  id,
  kind,
  name: id,
  enabled: true,
  providers: ['claude', 'codex'],
  ...(kind === 'mcp' ? {} : { compareHash: hash('a') }),
  ...more
})
const report = (extensions: ReportExtension[] | null): ControlPlaneReport => ({
  version: 1,
  astera: { version: '1.5.0', platform: 'darwin' },
  extensions,
  profiles: null,
  appBypass: null,
  policy: null,
  sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'sandbox', blocker: null } },
  credentials: null,
  secretStore: { kind: 'owner-only-files', ok: true },
  findings: null
})
/** Office, which expects `expected` and whose kept snapshot lists `there` (null: it could not read its registry; undefined:
 *  no snapshot). */
const office = (expected: string[], there: ReportExtension[] | null | undefined): RuntimeProfile =>
  runtime('rt_office', { name: 'Office', expected, ...(there !== undefined && { snapshot: { readAt: READ_AT, report: report(there) } }) })
const withLocal = (runtimes: RuntimeProfile[], localExtensions: ReportExtension[]): FindingInputs => ({ ...inputs(runtimes), localExtensions })

describe('runtime-missing-extension (remote governance design §9.2)', () => {
  it("a missing expected skill raises runtime-missing-extension naming the state, the extension and the snapshot's time", () => {
    expect(runtimeExtensionFindings(withLocal([office(['my-skill'], [])], [ext('my-skill')]))).toEqual([
      {
        key: 'runtime-missing-extension:rt_office:my-skill',
        rule: 'runtime-missing-extension',
        subject: { kind: 'runtime', id: 'rt_office', name: 'Office' },
        profileIds: [],
        part: 'my-skill',
        message: { key: 'findings.reason.runtimeExtension.missing', params: { extension: 'my-skill', at: READ_AT } },
        reason: `my-skill is not there, as of ${READ_AT}.`,
        suggestion: { key: 'findings.do.fixOnRuntime', params: { runtime: 'Office' } },
        action: 'On Office, install, update, turn on or add the secret in its Settings › MCP & Skills.',
        open: { kind: 'runtimes', runtimeId: 'rt_office' },
        ignored: false
      }
    ])
  })

  it('different, off and secret missing each have their own reason key', () => {
    const local = [ext('changed'), ext('switched'), ext('linear', 'mcp', { secretNames: ['API_KEY', 'TEAM_TOKEN'] })]
    const there = [ext('changed', 'skill', { compareHash: hash('b') }), ext('switched', 'skill', { enabled: false }), ext('linear', 'mcp', { secretNames: ['API_KEY'] })]
    const found = runtimeExtensionFindings(withLocal([office(['changed', 'switched', 'linear'], there)], local))
    expect(found.map((f) => [f.part, f.message])).toEqual([
      ['linear', { key: 'findings.reason.runtimeExtension.secretMissing', params: { extension: 'linear', names: 'TEAM_TOKEN', at: READ_AT } }],
      ['changed', { key: 'findings.reason.runtimeExtension.different', params: { extension: 'changed', at: READ_AT } }],
      ['switched', { key: 'findings.reason.runtimeExtension.off', params: { extension: 'switched', at: READ_AT } }]
    ])
    expect(found[0].reason).toBe(`linear there lacks a secret this computer stores for it: TEAM_TOKEN, as of ${READ_AT}.`)
  })

  it('same raises nothing', () => {
    expect(runtimeExtensionFindings(withLocal([office(['my-skill'], [ext('my-skill')])], [ext('my-skill')]))).toEqual([])
    // Nor does an entry missing there that is not expected
    expect(runtimeExtensionFindings(withLocal([office([], [])], [ext('my-skill')]))).toEqual([])
  })

  it('an id expected but gone from this computer raises nothing', () => {
    const i = withLocal([office(['gone'], [])], [ext('my-skill')])
    expect(runtimeExtensionFindings(i)).toEqual([])
    // Nor an information line while it has no snapshot
    expect(runtimeExtensionInfo(withLocal([office(['gone'], undefined)], [ext('my-skill')]))).toEqual([])
  })

  it('no snapshot yet gives the info line findings.info.runtimeNotRead, never a finding', () => {
    const i = withLocal([office(['my-skill'], undefined), runtime('rt_none', { expected: [] })], [ext('my-skill')])
    expect(runtimeExtensionFindings(i)).toEqual([])
    expect(runtimeExtensionInfo(i)).toEqual([
      {
        subject: { kind: 'runtime', id: 'rt_office', name: 'Office' },
        message: { key: 'findings.info.runtimeNotRead' },
        reason: 'Not read yet. Open its detail in Settings › Remote Runtimes.'
      }
    ])
  })

  // Ruling R9-3: a Runtime that could not read its registry sent no list, which is not "nothing installed"
  it('a snapshot whose extensions are null gives the info line too, never a finding', () => {
    const i = withLocal([office(['my-skill'], null)], [ext('my-skill')])
    expect(runtimeExtensionFindings(i)).toEqual([])
    expect(runtimeExtensionInfo(i).map((l) => [l.subject.id, l.message.key])).toEqual([['rt_office', 'findings.info.runtimeNotRead']])
    // A snapshot with a list gives no line
    expect(runtimeExtensionInfo(withLocal([office(['my-skill'], [])], [ext('my-skill')]))).toEqual([])
  })
})

describe('outdated-runtime (remote governance design §9.3)', () => {
  const facts = (asteraVersion: string): RuntimeProfile['facts'] => ({ asteraVersion, platform: 'darwin', hostProtocol: 4, capabilities: [], readAt: ago(1) })

  it('a Runtime older than this app is outdated-runtime with both versions', () => {
    const i: FindingInputs = { ...inputs([runtime('rt_a', { name: 'Office', facts: facts('1.4.9') })]), asteraVersion: '1.5.0' }
    expect(outdatedRuntimeFindings(i)).toEqual([
      {
        key: 'outdated-runtime:rt_a',
        rule: 'outdated-runtime',
        subject: { kind: 'runtime', id: 'rt_a', name: 'Office' },
        profileIds: [],
        message: { key: 'findings.reason.outdatedRuntime', params: { there: '1.4.9', here: '1.5.0' } },
        reason: 'Astera 1.4.9 there, 1.5.0 here.',
        suggestion: { key: 'findings.do.updateRuntime', params: { runtime: 'Office' } },
        action: 'Update Astera on Office.',
        open: { kind: 'runtimes', runtimeId: 'rt_a' },
        ignored: false
      }
    ])
  })

  it('a newer one is not', () => {
    const runtimes = [runtime('rt_a', { facts: facts('1.6.0') }), runtime('rt_b', { facts: facts('1.5.0') }), runtime('rt_c', { facts: facts('junk') }), runtime('rt_d')]
    expect(outdatedRuntimeFindings({ ...inputs(runtimes), asteraVersion: '1.5.0' })).toEqual([])
    // With no version of its own, this app flags none
    expect(outdatedRuntimeFindings(inputs([runtime('rt_a', { facts: facts('1.4.9') })]))).toEqual([])
  })
})
