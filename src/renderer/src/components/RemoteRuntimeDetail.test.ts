// Settings › Remote Runtimes' detail of a paired Runtime (remote governance design §10.1), rendered as markup with the
// catalog keys standing in for the words.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeDetail } from '../../../core/types'
import type { ComparisonRow } from '../../../core/controlPlane/compare'
import type { ControlPlaneReport, ReportExtension } from '../../../core/controlPlane/report'
import { RuntimeDetailView } from './RemoteRuntimesSettings'
import { localTime } from './findingsText'

/** What the mocked `t` gives, as the markup holds it (a quote escaped). */
const words = (key: string, params?: unknown): string => (params === undefined ? key : `${key}${JSON.stringify(params)}`).replace(/"/g, '&quot;')
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string, params?: unknown) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    tm: (m: { key: string } | null) => (m === null ? null : m.key)
  })
}))

const SEEN = '2026-10-08T01:02:03.000Z'
const READ = '2026-10-08T04:05:06.000Z'
const PAIRED = '2026-09-01T10:00:00.000Z'
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const ext = (id: string, kind: ReportExtension['kind'], over: Partial<ReportExtension> = {}): ReportExtension => ({ id, kind, name: id, enabled: true, providers: ['claude'], ...over })
const row = (id: string, kind: ReportExtension['kind'], expected: boolean, state: ComparisonRow['state'], here: boolean, there: boolean): ComparisonRow => ({
  id,
  kind,
  name: id.toUpperCase(),
  expected,
  state,
  here: here ? ext(id, kind) : null,
  there: there ? ext(id, kind, { enabled: state !== 'off' }) : null
})
const REPORT: ControlPlaneReport = {
  version: 1,
  astera: { version: '1.4.8', platform: 'darwin' },
  extensions: [ext('skill-a', 'skill')],
  profiles: [
    { id: 'p1', name: 'Review', status: 'active', permission: 'bypass', sandbox: true, mcpExclude: [], accountsThere: 1, accountsNamed: 2 },
    { id: 'p2', name: 'Old', status: 'archived', permission: 'tight', sandbox: false, mcpExclude: [], accountsThere: 0, accountsNamed: 0 }
  ],
  appBypass: false,
  policy: {
    mode: 'observe',
    otherwise: 'allow',
    rules: 3,
    enforce: { claude: { terminal: null, chat: 'hooks-off' }, codex: { terminal: 'codex-daemon', chat: null } },
    cliVersions: { claude: '2.1.300', codex: null }
  },
  sandbox: { claude: { kind: 'sandbox', blocker: 'userns-restricted' }, codex: { kind: 'microvm', blocker: null }, codexAccounts: { ready: 1, total: 2 } },
  credentials: {
    hideOnly: [{ alias: 'npm', presets: ['npm'], envNames: ['NPM_TOKEN'], hidden: true }],
    mcp: [{ serverId: 'mcp-gh', serverName: 'GitHub', names: ['GH_TOKEN'], hidden: false }]
  },
  secretStore: { kind: 'owner-only-files', ok: false, code: 'secret-file-unsafe' },
  findings: { total: 4, byRule: { 'stale-runtime': 1 } }
}
const detail = (over: Partial<RuntimeDetail> = {}): RuntimeDetail => ({
  runtimeId: 'rt_a',
  name: 'Office',
  fingerprint: FINGERPRINT,
  permission: 'full-control',
  createdAt: PAIRED,
  lastSeenAt: SEEN,
  facts: { asteraVersion: '1.4.8', platform: 'darwin', hostProtocol: 4, capabilities: [], readAt: SEEN },
  here: '1.5.0',
  older: true,
  answering: true,
  snapshot: { readAt: READ, report: REPORT },
  comparison: [
    row('mcp-a', 'mcp', true, 'missing', true, false),
    row('skill-a', 'skill', true, 'different', true, true),
    row('skill-b', 'skill', true, 'same', true, true),
    row('skill-d', 'skill', false, null, true, false),
    row('skill-z', 'skill', false, null, false, true)
  ],
  ...over
})
const render = (d: RuntimeDetail): string =>
  renderToStaticMarkup(React.createElement(RuntimeDetailView, { detail: d, busy: false, onRefresh: () => {}, onExpect: () => {}, now: Date.parse(READ) }))
/** The text of the part under a heading, up to the next heading. */
const part = (html: string, heading: string): string => {
  const at = html.indexOf(`>${heading}<`)
  if (at < 0) throw new Error(`no part ${heading}`)
  const next = html.indexOf('settings-field-label', at + heading.length)
  return html.slice(at, next < 0 ? undefined : next)
}

describe('the Runtime detail (remote governance design §10.1)', () => {
  it('the identity part shows the runtime id, the fingerprint shortened to 16 characters with the full one on copy, paired at and the permission', () => {
    const identity = part(render(detail()), 'settings.remote.detail.identity')
    expect(identity).toContain(words('settings.remote.detail.runtimeId', { id: 'rt_a' }))
    expect(identity).toContain(words('settings.remote.detail.fingerprint', { fingerprint: `${FINGERPRINT.slice(0, 16)}…` }))
    expect(identity).not.toContain(FINGERPRINT)
    expect(identity).toContain('>settings.remote.detail.copyFingerprint</button>')
    expect(identity).toContain(words('settings.remote.detail.pairedAt', { at: localTime(PAIRED) }))
    expect(identity).toContain('settings.remote.paired.fullControl')
  })

  it('the health part shows last seen, answering or the existing does-not-answer line, the versions and the OS', () => {
    const health = part(render(detail()), 'settings.remote.detail.health')
    expect(health).toContain(words('settings.remote.paired.lastSeen', { at: localTime(SEEN) }))
    expect(health).toContain('settings.remote.detail.answers')
    expect(health).toContain(words('settings.remote.detail.versions', { there: '1.4.8', here: '1.5.0' }))
    expect(health).toContain('settings.remote.detail.updateThere')
    expect(health).toContain(words('settings.remote.detail.os', { platform: 'darwin' }))
    const offline = part(render(detail({ answering: false, refusal: { code: 'RUNTIME_OFFLINE', message: 'connect ECONNREFUSED' } })), 'settings.remote.detail.health')
    expect(offline).toContain(words('settings.remote.paired.offline', { code: 'RUNTIME_OFFLINE' }))
    expect(offline).not.toContain('settings.remote.detail.answers')
    // Ruling R16-1: a refusal remembered from a read a moment ago did not ask now (answering null), and its code still
    // says the Runtime does not answer
    const remembered = part(render(detail({ answering: null, refusal: { code: 'RUNTIME_OFFLINE', message: 'connect ECONNREFUSED' } })), 'settings.remote.detail.health')
    expect(remembered).toContain(words('settings.remote.paired.offline', { code: 'RUNTIME_OFFLINE' }))
    // A kept report this read did not ask for says nothing either way
    const kept = part(render(detail({ answering: null })), 'settings.remote.detail.health')
    expect(kept).not.toContain('settings.remote.detail.answers')
    expect(kept).not.toContain('settings.remote.paired.offline')
    // Never reached, and no hello yet: no versions or OS to show
    const never = part(render(detail({ lastSeenAt: null, facts: null, older: false })), 'settings.remote.detail.health')
    expect(never).toContain('settings.remote.paired.neverSeen')
    expect(never).not.toContain('settings.remote.detail.versions')
    expect(never).not.toContain('settings.remote.detail.os')
  })

  it('the agents part lists profiles with permission and sandbox, and the permission setting', () => {
    const agents = part(render(detail()), 'settings.remote.detail.agents')
    expect(agents).toContain('settings.remote.detail.bypassOff')
    expect(agents).toContain('Review')
    expect(agents).toContain('settings.agentProfiles.permission.bypass')
    expect(agents).toContain('settings.remote.detail.sandboxOn')
    expect(agents).toContain(words('settings.remote.detail.accounts', { there: 1, named: 2 }))
    // An archived profile says so; ruling R2-1: a permission word this build does not know is shown as it came
    expect(agents).toContain('settings.agentProfiles.archived')
    expect(agents).toContain('tight')
    expect(agents).toContain('settings.remote.detail.sandboxOff')
    const on = part(render(detail({ snapshot: { readAt: READ, report: { ...REPORT, appBypass: true, profiles: null } } })), 'settings.remote.detail.agents')
    expect(on).toContain('settings.remote.detail.bypassOn')
    expect(on).toContain('settings.remote.detail.unread')
  })

  it('the protection part shows the policy mode, Enforce per provider with its blocker words, sandbox per provider and CLI versions', () => {
    const protection = part(render(detail()), 'settings.remote.detail.protection')
    expect(protection).toContain(words('settings.remote.detail.policy', { mode: 'Observe', otherwise: 'settings.security.effect.allow', rules: 3 }))
    expect(protection).toContain('settings.remote.detail.enforceReady')
    expect(protection).toContain(words('settings.remote.detail.enforceBlocked', { code: 'hooks-off' }))
    expect(protection).toContain(words('settings.remote.detail.enforceBlocked', { code: 'codex-daemon' }))
    expect(protection).toContain(words('settings.remote.detail.sandbox', { provider: 'Claude', kind: 'settings.remote.detail.sandboxKind.sandbox' }))
    expect(protection).toContain('userns-restricted')
    // Ruling R2-1: a sandbox kind this build does not know is shown as its word
    expect(protection).toContain(words('settings.remote.detail.sandbox', { provider: 'Codex', kind: 'microvm' }))
    expect(protection).toContain(words('settings.remote.detail.codexAccounts', { ready: 1, total: 2 }))
    expect(protection).toContain(words('settings.remote.detail.cliVersion', { provider: 'Claude', version: '2.1.300' }))
    expect(protection).toContain(words('settings.remote.detail.cliMissing', { provider: 'Codex' }))
    // A mode and an otherwise choice this build does not know are shown as their words
    const newer = { ...REPORT, policy: { ...REPORT.policy!, mode: 'audit-only', otherwise: 'ask' } }
    const shown = part(render(detail({ snapshot: { readAt: READ, report: newer } })), 'settings.remote.detail.protection')
    expect(shown).toContain(words('settings.remote.detail.policy', { mode: 'audit-only', otherwise: 'ask', rules: 3 }))
    const unread = part(render(detail({ snapshot: { readAt: READ, report: { ...REPORT, policy: null } } })), 'settings.remote.detail.protection')
    expect(unread).toContain('settings.remote.detail.unread')
  })

  it("the extensions part lists this computer's and the Runtime's entries side by side", () => {
    const html = part(render(detail()), 'settings.remote.detail.extensions')
    // A checkbox per local entry marks it expected
    expect(html.match(/type="checkbox"/g)).toHaveLength(4)
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(3)
    // Each expected row shows its state
    expect(html).toContain('settings.remote.detail.state.missing')
    expect(html).toContain('settings.remote.detail.state.different')
    expect(html).toContain('settings.remote.detail.state.same')
    // An entry only there is listed
    expect(html).toContain('SKILL-Z')
    expect(html).toContain('settings.remote.detail.state.onlyThere')
    // Not same somewhere: where to fix it
    expect(html).toContain('settings.remote.detail.installThere')
    const allSame = part(render(detail({ comparison: [row('skill-b', 'skill', true, 'same', true, true)] })), 'settings.remote.detail.extensions')
    expect(allSame).not.toContain('settings.remote.detail.installThere')
    // Ruling R9-3: the Runtime could not read its extensions, which is not "nothing there"
    const unread = part(
      render(detail({ snapshot: { readAt: READ, report: { ...REPORT, extensions: null } }, comparison: [row('skill-a', 'skill', true, null, true, false)] })),
      'settings.remote.detail.extensions'
    )
    expect(unread).toContain('settings.remote.detail.extensionsUnread')
    // Ruling R17-1: the local rows stay, to tick, with nothing judged and the other side not read
    expect(unread).toContain('SKILL-A')
    expect(unread.match(/type="checkbox"/g)).toHaveLength(1)
    expect(unread).toContain('settings.remote.detail.thereNotRead')
    expect(unread).not.toContain('settings.remote.detail.state.')
    expect(unread.indexOf('settings.remote.detail.extensionsUnread')).toBeLessThan(unread.indexOf('<table'))
    // Each kind starts with a heading over the columns
    expect(html).toContain('<th colSpan="5" scope="colgroup">settings.extensions.kind.mcp</th>')
    // Ruling R16-1: this computer's extensions could not be read; the line stands in for the rows, the rest still shows
    const local = render(detail({ localError: true, comparison: [] }))
    expect(part(local, 'settings.remote.detail.extensions')).toContain('settings.remote.detail.localError')
    expect(local).toContain('settings.remote.detail.valuesStay')
  })

  // Ruling R17-1: §6.1 and §10.1 make this detail the place to set the expected list, from this computer's set, so it
  // is there before the first readable report and for a Runtime too old to report
  it('the extensions part lists the entries here to tick before any report, for an older Runtime too', () => {
    const local = [row('mcp-a', 'mcp', true, null, true, false), row('skill-d', 'skill', false, null, true, false)]
    for (const d of [
      detail({ snapshot: null, comparison: local }),
      detail({ snapshot: null, comparison: local, refusal: { code: 'RUNTIME_CAPABILITY_MISSING', message: 'update Astera there' } })
    ]) {
      const html = part(render(d), 'settings.remote.detail.extensions')
      expect(html.match(/type="checkbox"/g)).toHaveLength(2)
      expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1)
      expect(html.match(/settings\.remote\.detail\.thereNotRead/g)).toHaveLength(2)
      expect(html).not.toContain('settings.remote.detail.state.')
      // No report to judge against: no advice to install there
      expect(html).not.toContain('settings.remote.detail.installThere')
      expect(html.indexOf('settings.remote.detail.notReadYet')).toBeLessThan(html.indexOf('<table'))
    }
    // Nothing here and nothing there: a short line, not an empty part
    expect(part(render(detail({ comparison: [] })), 'settings.remote.detail.extensions')).toContain('settings.remote.detail.noExtensions')
    expect(part(render(detail({ snapshot: null, comparison: [] })), 'settings.remote.detail.extensions')).toContain('settings.remote.detail.noExtensions')
    // A failure says why instead
    expect(part(render(detail({ localError: true, comparison: [] })), 'settings.remote.detail.extensions')).not.toContain('settings.remote.detail.noExtensions')
  })

  // Ruling R17-1: a link that failed for a reason the person can act on says it in plain words, whether this read asked
  // (answering false) or a refusal remembered a moment ago answered (answering null); a changed identity is not "does not answer"
  it('names a refused pairing, a changed identity and a version mismatch in plain words on both paths', () => {
    const cases: Array<[string, string]> = [
      ['RUNTIME_AUTH_FAILED', 'settings.remote.link.authFailed'],
      ['RUNTIME_IDENTITY_CHANGED', 'settings.remote.link.identityChanged'],
      ['RUNTIME_PROTOCOL_MISMATCH', 'settings.remote.link.protocolMismatch']
    ]
    for (const [code, key] of cases)
      for (const answering of [false, null]) {
        const html = render(detail({ answering, refusal: { code, message: 'm' } }))
        expect(part(html, 'settings.remote.detail.health'), `${code} ${answering}`).toContain(key)
        expect(html, `${code} ${answering}`).not.toContain('settings.remote.paired.offline')
        expect(html, `${code} ${answering}`).not.toContain(words('settings.remote.failed', { code, message: 'm' }))
      }
  })

  it('the credentials part shows names and hidden flags under the line that values stay on that computer', () => {
    const credentials = part(render(detail()), 'settings.remote.detail.credentials')
    const stay = credentials.indexOf('settings.remote.detail.valuesStay')
    expect(stay).toBeGreaterThan(0)
    expect(credentials.indexOf('npm')).toBeGreaterThan(stay)
    expect(credentials).toContain('NPM_TOKEN')
    expect(credentials).toContain('GitHub')
    expect(credentials).toContain('GH_TOKEN')
    expect(credentials).toContain('settings.remote.detail.hidden')
    expect(credentials).toContain('settings.remote.detail.notHidden')
  })

  it('the secret store part and the findings count', () => {
    const html = render(detail())
    expect(html).toContain(words('settings.remote.detail.secretStore', { state: words('settings.remote.detail.secretStoreFailed', { code: 'secret-file-unsafe' }).replace(/&quot;/g, '"') }))
    expect(html).toContain(words('settings.remote.detail.findingsThere', { count: 4 }))
    const ok = render(detail({ snapshot: { readAt: READ, report: { ...REPORT, secretStore: { kind: 'os-keychain', ok: true }, findings: null } } }))
    // Ruling R2-1: a store kind this build does not know is named as its word
    expect(ok).toContain(words('settings.remote.detail.secretStoreOther', { kind: 'os-keychain', state: 'settings.remote.detail.secretStoreOk' }))
    expect(ok).not.toContain('settings.remote.detail.findingsThere')
  })

  it('read time and Refresh; with no snapshot, "not read yet"; with refusal RUNTIME_CAPABILITY_MISSING, the update line', () => {
    const html = render(detail())
    expect(html).toContain(words('settings.remote.detail.readAt', { at: localTime(READ) }))
    expect(html).toContain('>settings.remote.detail.refresh</button>')
    const never = render(detail({ snapshot: null, comparison: [] }))
    expect(never).toContain('settings.remote.detail.notReadYet')
    expect(never).not.toContain('settings.remote.detail.valuesStay')
    expect(never).toContain('>settings.remote.detail.refresh</button>')
    const older = render(
      detail({ snapshot: null, comparison: [], refusal: { code: 'RUNTIME_CAPABILITY_MISSING', message: 'this Runtime cannot report its setup; update Astera there' } })
    )
    expect(older).toContain('settings.remote.detail.unsupported')
    // The unsupported line already says to update there; the screen says it once
    expect(older).not.toContain('settings.remote.detail.updateThere')
    expect(older).not.toContain('settings.remote.paired.offline')
    // Any other refusal with its code and message
    const refused = render(detail({ refusal: { code: 'RUNTIME_PERMISSION_DENIED', message: 'answers a person' } }))
    expect(refused).toContain(words('settings.remote.failed', { code: 'RUNTIME_PERMISSION_DENIED', message: 'answers a person' }))
    expect(refused).not.toContain('settings.remote.paired.offline')
    // Refresh waits while a read is running
    const busy = renderToStaticMarkup(React.createElement(RuntimeDetailView, { detail: detail(), busy: true, onRefresh: () => {}, onExpect: () => {}, now: 0 }))
    expect(busy).toContain('disabled="">settings.remote.detail.refresh</button>')
  })

  it('offline: the last snapshot under the does-not-answer line, with its read time', () => {
    const html = render(detail({ answering: false, refusal: { code: 'RUNTIME_OFFLINE', message: 'connect ECONNREFUSED' } }))
    const line = html.indexOf(words('settings.remote.paired.offline', { code: 'RUNTIME_OFFLINE' }))
    const read = html.indexOf(words('settings.remote.detail.readAt', { at: localTime(READ) }))
    expect(line).toBeGreaterThan(0)
    expect(read).toBeGreaterThan(line)
    for (const heading of ['settings.remote.detail.extensions', 'settings.remote.detail.agents', 'settings.remote.detail.protection', 'settings.remote.detail.credentials'])
      expect(html.indexOf(`>${heading}<`), heading).toBeGreaterThan(read)
  })
})
