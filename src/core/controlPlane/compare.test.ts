import { describe, it, expect, vi } from 'vitest'
import { compareExtensions, liveExpected } from './compare'
import type { ControlPlaneReport, ReportExtension } from './report'

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

/** The state of `here`, expected, compared against `there` (absent = no entry there). */
const stateOf = (here: ReportExtension, there?: ReportExtension) =>
  compareExtensions({ local: [here], report: report(there ? [there] : []), expected: [here.id] }).find((r) => r.id === here.id)?.state

describe('compareExtensions (remote governance design §6.2)', () => {
  it('an expected id with no entry there is missing', () => {
    expect(stateOf(ext('x'))).toBe('missing')
  })

  it('a file kind whose comparison hashes differ is different; equal hashes are same', () => {
    for (const kind of ['skill', 'command', 'agent'] as const) {
      expect(stateOf(ext('x', kind), ext('x', kind, { compareHash: hash('b') }))).toBe('different')
      expect(stateOf(ext('x', kind), ext('x', kind))).toBe('same')
    }
  })

  // Planning ruling 10: an unreadable copy makes no claim about its content.
  it('a hash missing on either side is not judged different', () => {
    expect(stateOf(ext('x', 'skill', { compareHash: undefined }), ext('x'))).toBe('same')
    expect(stateOf(ext('x'), ext('x', 'skill', { compareHash: undefined }))).toBe('same')
    expect(stateOf(ext('x', 'skill', { compareHash: undefined }), ext('x', 'skill', { compareHash: undefined }))).toBe('same')
  })

  it('disabled there is off', () => {
    expect(stateOf(ext('x'), ext('x', 'skill', { enabled: false }))).toBe('off')
  })

  it('there but not given to a provider this computer gives it to is off', () => {
    expect(stateOf(ext('x'), ext('x', 'skill', { providers: ['claude'] }))).toBe('off')
    // Given to more providers there than here is not off.
    expect(stateOf(ext('x', 'skill', { providers: ['claude'] }), ext('x'))).toBe('same')
  })

  // Ruling R11-1: an entry disabled here is given to no provider here, so off never applies to it.
  it('an entry disabled on this computer is never off', () => {
    expect(stateOf(ext('x', 'skill', { enabled: false }), ext('x', 'skill', { enabled: false }))).toBe('same')
    expect(stateOf(ext('x', 'skill', { enabled: false }), ext('x', 'skill', { providers: ['claude'] }))).toBe('same')
    expect(stateOf(ext('x'), ext('x', 'skill', { enabled: false }))).toBe('off')
    expect(stateOf(ext('m', 'mcp', { enabled: false, secretNames: ['K'] }), ext('m', 'mcp', { enabled: false }))).toBe('secret-missing')
  })

  it('names sort the same whatever the machine locale is', () => {
    // A machine whose default locale is Swedish, where "ä" sorts after "z"; in English it sorts with "a".
    const original = String.prototype.localeCompare
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, that, locales, options) {
      return original.call(this, that, locales ?? 'sv', options)
    })
    try {
      const rows = compareExtensions({ local: [ext('z', 'skill', { name: 'zeta' }), ext('a', 'skill', { name: 'äpple' })], report: null, expected: undefined })
      expect(rows.map((r) => r.name)).toEqual(['äpple', 'zeta'])
    } finally {
      spy.mockRestore()
    }
  })

  it('an MCP server whose secret names here include one there lacks is secret-missing', () => {
    const here = ext('m', 'mcp', { secretNames: ['GH_TOKEN', 'NPM_TOKEN'] })
    expect(stateOf(here, ext('m', 'mcp', { secretNames: ['GH_TOKEN'] }))).toBe('secret-missing')
    expect(stateOf(here, ext('m', 'mcp'))).toBe('secret-missing')
    expect(stateOf(here, ext('m', 'mcp', { secretNames: ['NPM_TOKEN', 'GH_TOKEN', 'EXTRA'] }))).toBe('same')
    expect(stateOf(ext('m', 'mcp'), ext('m', 'mcp', { secretNames: ['GH_TOKEN'] }))).toBe('same')
  })

  it('a row is given one state, in the order missing, different, off, secret-missing, same', () => {
    const hereMcp = ext('m', 'mcp', { secretNames: ['K'] })
    expect(stateOf(hereMcp, ext('m', 'mcp', { enabled: false }))).toBe('off')
    expect(stateOf(ext('x'), ext('x', 'skill', { compareHash: hash('b'), enabled: false, providers: [] }))).toBe('different')
    expect(stateOf(hereMcp)).toBe('missing')
    expect(stateOf(hereMcp, ext('m', 'mcp', { secretNames: ['K'] }))).toBe('same')
  })

  it('an entry only there is listed with state null and expected false', () => {
    const rows = compareExtensions({ local: [ext('x')], report: report([ext('x'), ext('y', 'agent')]), expected: ['x', 'y'] })
    const y = rows.find((r) => r.id === 'y')
    expect(y).toEqual({ id: 'y', kind: 'agent', name: 'y', expected: false, here: null, there: ext('y', 'agent'), state: null })
  })

  it('a not-expected local entry is listed with state null', () => {
    const rows = compareExtensions({ local: [ext('x'), ext('z')], report: report([]), expected: ['x'] })
    expect(rows.find((r) => r.id === 'z')).toEqual({ id: 'z', kind: 'skill', name: 'z', expected: false, here: ext('z'), there: null, state: null })
    expect(rows.find((r) => r.id === 'x')?.state).toBe('missing')
  })

  it('with no snapshot every state is null', () => {
    const rows = compareExtensions({ local: [ext('x'), ext('m', 'mcp')], report: null, expected: ['x', 'm'] })
    expect(rows.map((r) => [r.id, r.expected, r.there, r.state])).toEqual([
      ['m', true, null, null],
      ['x', true, null, null]
    ])
  })

  // Ruling R9-3: a Runtime that could not read its registry has not said "nothing installed", so nothing reads missing.
  it('a snapshot whose extensions could not be read compares like no snapshot, never as all missing', () => {
    const local = [ext('x'), ext('m', 'mcp')]
    const unread = compareExtensions({ local, report: report(null), expected: ['x', 'm'] })
    expect(unread).toEqual(compareExtensions({ local, report: null, expected: ['x', 'm'] }))
    expect(unread.every((r) => r.state === null)).toBe(true)
    expect(compareExtensions({ local, report: report([]), expected: ['x', 'm'] }).map((r) => r.state)).toEqual(['missing', 'missing'])
  })

  it('rows sort by kind (mcp, skill, command, agent), then name', () => {
    const rows = compareExtensions({
      local: [ext('a1', 'agent'), ext('s2', 'skill', { name: 'beta' }), ext('c1', 'command'), ext('s1', 'skill', { name: 'alpha' })],
      report: report([ext('m1', 'mcp'), ext('s3', 'skill', { name: 'gamma' })]),
      expected: undefined
    })
    expect(rows.map((r) => r.id)).toEqual(['m1', 's1', 's2', 's3', 'c1', 'a1'])
  })

  it('a row takes its kind and name from this computer when the entry is here', () => {
    const rows = compareExtensions({ local: [ext('x', 'skill', { name: 'Here name' })], report: report([ext('x', 'skill', { name: 'There name' })]), expected: ['x'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Here name')
  })
})

describe('liveExpected (remote governance design §6.1)', () => {
  it('liveExpected drops an id this computer no longer has', () => {
    expect(liveExpected(['b', 'gone', 'a'], [ext('a'), ext('b')])).toEqual(['b', 'a'])
    expect(liveExpected(undefined, [ext('a')])).toEqual([])
  })
})
