import { describe, it, expect } from 'vitest'
import { parseControlPlaneReport, SANDBOX_BLOCKER_CODES, type ControlPlaneReport, type ReportExtension } from './report'

const ext = (id: string, kind: ReportExtension['kind']): ReportExtension => ({ id, kind, name: id, enabled: true, providers: ['claude', 'codex'] })

const full = (): ControlPlaneReport & { extensions: ReportExtension[] } => ({
  version: 1,
  astera: { version: '1.5.0', platform: 'darwin' },
  extensions: [
    { ...ext('mcp-gh', 'mcp'), secretNames: ['GH_TOKEN'], gateway: 'running' },
    { ...ext('skill-a', 'skill'), compareHash: 'cmp1:sha256:' + 'a'.repeat(64) },
    { ...ext('cmd-b', 'command'), enabled: false, providers: ['claude'], compareHash: 'cmp1:sha256:' + 'b'.repeat(64) },
    ext('agent-c', 'agent')
  ],
  profiles: [
    { id: 'p1', name: 'Review', status: 'active', permission: 'bypass', sandbox: true, mcpExclude: ['mcp-gh'], accountsThere: 1, accountsNamed: 2 }
  ],
  appBypass: false,
  policy: {
    mode: 'observe',
    otherwise: 'allow',
    rules: 3,
    observingSince: '2026-10-30T00:00:00.000Z',
    enforce: { claude: { terminal: null, chat: 'hooks-off' }, codex: { terminal: 'codex-daemon', chat: null } },
    cliVersions: { claude: '2.1.300', codex: null }
  },
  sandbox: { claude: { kind: 'sandbox', blocker: 'userns-restricted' }, codex: { kind: 'deny-only', blocker: null }, codexAccounts: { ready: 1, total: 2 } },
  credentials: {
    hideOnly: [{ alias: 'npm', presets: ['npm'], envNames: ['NPM_TOKEN'], hidden: true }],
    mcp: [{ serverId: 'mcp-gh', serverName: 'GitHub', names: ['GH_TOKEN'], hidden: false }]
  },
  secretStore: { kind: 'owner-only-files', ok: false, code: 'acl-open' },
  findings: { total: 4, byRule: { 'stale-runtime': 1, 'unpinned-mcp': 3 } }
})

const errorOf = (v: unknown): string | undefined => {
  const r = parseControlPlaneReport(v)
  return 'error' in r ? r.error : undefined
}

describe('parseControlPlaneReport (remote governance design §5.2, §5.3)', () => {
  it('a full report parses to itself', () => {
    expect(parseControlPlaneReport(full())).toEqual(full())
  })

  it('fields the parser does not know never come through', () => {
    const r = full() as unknown as Record<string, unknown>
    const exts = r.extensions as Array<Record<string, unknown>>
    Object.assign(exts[0], { command: 'npx', args: ['-y', 'x'], url: 'https://h', env: { K: 'v' }, lastError: 'C:/x' })
    r.path = '/home/me'
    ;(r.profiles as Array<Record<string, unknown>>)[0].accountIds = ['acc-1']
    const parsed = parseControlPlaneReport(r)
    expect(parsed).toEqual(full())
    const text = JSON.stringify(parsed)
    for (const leak of ['npx', 'https://h', '"v"', 'C:/x', '/home/me', 'accountIds']) expect(text).not.toContain(leak)
  })

  // Ruling R9-3: a Runtime that could not read its registry says so, rather than "nothing installed"
  it('extensions null is kept as not read', () => {
    const parsed = parseControlPlaneReport({ ...full(), extensions: null })
    expect(parsed).toEqual({ ...full(), extensions: null })
  })

  it('an extension of a kind this build does not know is dropped and the rest kept', () => {
    const r = full() as unknown as { extensions: unknown[] }
    r.extensions.splice(1, 0, { id: 'w', kind: 'workflow', name: 'w', enabled: true, providers: ['claude'] })
    const parsed = parseControlPlaneReport(r)
    expect(parsed).toEqual(full())
  })

  it('an unknown blocker code is kept as its code word', () => {
    const r = full()
    r.sandbox.claude.blocker = 'future-code'
    r.policy!.enforce!.codex.chat = 'future-code'
    const parsed = parseControlPlaneReport(r) as ReturnType<typeof full>
    expect(parsed.sandbox.claude.blocker).toBe('future-code')
    expect(parsed.policy!.enforce!.codex.chat).toBe('future-code')

    const bad = full()
    bad.sandbox.codex.blocker = 'Not a code!'
    expect(errorOf(bad)).toBeTypeOf('string')
    const badEnforce = full()
    badEnforce.policy!.enforce!.claude.terminal = 'Not a code!'
    expect(errorOf(badEnforce)).toBeTypeOf('string')
    const badRule = full()
    badRule.findings!.byRule = { 'Not a code!': 1 }
    expect(errorOf(badRule)).toBeTypeOf('string')
    const badCount = full()
    badCount.findings!.byRule = { 'stale-runtime': -1 }
    expect(errorOf(badCount)).toBeTypeOf('string')
  })

  it('an unknown gateway state leaves only that gateway unsaid (design §4.3)', () => {
    const r = full() as unknown as { extensions: Array<Record<string, unknown>> }
    r.extensions[0].gateway = 'paused'
    const parsed = parseControlPlaneReport(r) as ReturnType<typeof full>
    const { gateway: _gone, ...rest } = full().extensions[0]
    expect(parsed.extensions[0]).toEqual(rest)
    expect(parsed.extensions.slice(1)).toEqual(full().extensions.slice(1))
    r.extensions[0].gateway = 'Bad Value!'
    expect(errorOf(r)).toBeTypeOf('string')
  })

  it('an unknown state word is kept as its word, a malformed one refuses (design §4.3)', () => {
    const r = full()
    r.profiles![0].status = 'retired'
    r.profiles![0].permission = 'ask-once'
    r.policy!.mode = 'strict'
    r.policy!.otherwise = 'ask'
    r.sandbox.codex.kind = 'vm'
    r.secretStore.kind = 'keychain'
    expect(parseControlPlaneReport(r)).toEqual(r)

    const set: Array<(x: ControlPlaneReport) => void> = [
      (x) => (x.profiles![0].status = 'Bad Value!'),
      (x) => (x.profiles![0].permission = 'Bad Value!'),
      (x) => (x.policy!.mode = 'Bad Value!'),
      (x) => (x.policy!.otherwise = 'Bad Value!'),
      (x) => (x.sandbox.claude.kind = 'Bad Value!'),
      (x) => (x.secretStore.kind = 'Bad Value!'),
      (x) => ((x.policy as unknown as Record<string, unknown>).mode = 3)
    ]
    for (const s of set) {
      const bad = full()
      s(bad)
      expect(errorOf(bad)).toBeTypeOf('string')
    }
  })

  it('names srt missing among the sandbox blocker codes after the user namespace one (ruling C5)', () => {
    expect(SANDBOX_BLOCKER_CODES).toEqual(['no-check-runner', 'userns-restricted', 'runtime-missing'])
  })

  it('wrong types are refused', () => {
    expect(errorOf({ ...full(), version: 2 })).toBeTypeOf('string')
    expect(errorOf({ ...full(), extensions: {} })).toBeTypeOf('string')
    expect(errorOf({ ...full(), policy: { ...full().policy, rules: '3' } })).toBeTypeOf('string')
    const named = full() as unknown as { extensions: Array<Record<string, unknown>> }
    named.extensions[2].name = 7
    expect(errorOf(named)).toBeTypeOf('string')
    expect(errorOf(null)).toBeTypeOf('string')
    expect(errorOf([])).toBeTypeOf('string')
  })

  it('oversize data is refused whole', () => {
    expect(errorOf({ ...full(), extensions: Array.from({ length: 2001 }, (_, i) => ext(`s${i}`, 'skill')) })).toBeTypeOf('string')
    expect(parseControlPlaneReport({ ...full(), extensions: Array.from({ length: 2000 }, (_, i) => ext(`s${i}`, 'skill')) })).not.toHaveProperty('error')

    const profile = full().profiles![0]
    expect(errorOf({ ...full(), profiles: Array.from({ length: 501 }, () => profile) })).toBeTypeOf('string')
    expect(parseControlPlaneReport({ ...full(), profiles: Array.from({ length: 500 }, () => profile) })).not.toHaveProperty('error')

    const long = full()
    long.astera.platform = 'x'.repeat(257)
    expect(errorOf(long)).toBeTypeOf('string')
    const edge = full()
    edge.astera.platform = 'x'.repeat(256)
    expect(parseControlPlaneReport(edge)).not.toHaveProperty('error')

    const names = full()
    names.extensions[0].secretNames = Array.from({ length: 257 }, (_, i) => `N${i}`)
    expect(errorOf(names)).toBeTypeOf('string')
    const namesEdge = full()
    namesEdge.extensions[0].secretNames = Array.from({ length: 256 }, (_, i) => `N${i}`)
    expect(parseControlPlaneReport(namesEdge)).not.toHaveProperty('error')

    const hide = full().credentials!.hideOnly[0]
    const creds = (n: number) => ({ ...full(), credentials: { hideOnly: Array.from({ length: n }, () => hide), mcp: [] } })
    expect(errorOf(creds(2001))).toBeTypeOf('string')
    expect(parseControlPlaneReport(creds(2000))).not.toHaveProperty('error')

    const rules = (n: number) => ({ ...full(), findings: { total: n, byRule: Object.fromEntries(Array.from({ length: n }, (_, i) => [`rule-${i}`, 1])) } })
    expect(errorOf(rules(257))).toBeTypeOf('string')
    expect(parseControlPlaneReport(rules(256))).not.toHaveProperty('error')

    const unsafe = full()
    unsafe.findings!.total = Number.MAX_SAFE_INTEGER + 1
    expect(errorOf(unsafe)).toBeTypeOf('string')
  })

  it('null parts stay null', () => {
    const r: ControlPlaneReport = { ...full(), profiles: null, appBypass: null, policy: null, credentials: null, findings: null }
    expect(parseControlPlaneReport(r)).toEqual(r)
  })
})
