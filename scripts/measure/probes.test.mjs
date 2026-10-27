// The sandbox probes (enforce and sandbox design §8, E4): each a shell line run in a workspace, judged against the same
// line with no sandbox, so a sandbox's "denied" never means only that the fixture was not there.
import { describe, it, expect } from 'vitest'
import { PROBES, probeTable, runProbes, runSet, verdict } from './probes.mjs'

const node = (line) => ({ file: process.execPath, args: ['-e', line] })
const probes = (...lines) => lines.map((line, i) => ({ id: `p${i}`, line }))
const at = { cwd: process.cwd(), env: process.env }

describe('runProbes', () => {
  it('runs each probe through the wrap and reads how it ended', () => {
    const [ok, failed] = runProbes(node, { ...at, probes: probes('process.exit(0)', 'process.stdout.write("no"); process.exit(3)') })
    expect(ok).toMatchObject({ id: 'p0', code: 0, ok: true, timedOut: false, missing: false })
    expect(failed).toMatchObject({ id: 'p1', code: 3, ok: false, out: 'no' })
  })

  it('takes only the probes asked for', () => {
    expect(runProbes(node, { ...at, probes: probes('process.exit(0)', 'process.exit(0)'), only: ['p1'] }).map((r) => r.id)).toEqual(['p1'])
  })

  it('records a missing program', () => {
    const [r] = runProbes(() => ({ file: 'astera-no-such-program', args: [] }), { ...at, probes: probes('x') })
    expect(r).toMatchObject({ missing: true, ok: false })
  })

  it('ends a probe at its timeout', () => {
    const started = Date.now()
    const [r] = runProbes(node, { ...at, timeoutMs: 300, probes: probes('setTimeout(() => {}, 60000)') })
    expect(r).toMatchObject({ timedOut: true, ok: false })
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('verdict', () => {
  it('calls a probe denied only when it worked unsandboxed', () => {
    expect(verdict({ ok: true }, { ok: false })).toBe('denied')
    expect(verdict({ ok: true }, { ok: true })).toBe('allowed')
    expect(verdict({ ok: false }, { ok: false })).toBe('fixture-broken')
    expect(verdict({ ok: true }, { ok: false, timedOut: true })).toBe('timeout')
    expect(verdict({ ok: true }, { ok: false, missing: true })).toBe('missing')
    expect(verdict({ ok: true }, { ok: false, refused: true })).toBe('refused')
  })
})

// Found by a smoke run: a sandbox that cannot start any command read as every probe denied
describe('runSet', () => {
  it('runs the probes only when the sandbox can start a command, and says it refused otherwise', () => {
    const ran = runSet(node, { ...at, probes: probes('process.exit(0)', 'process.exit(2)'), sanity: 'process.exit(0)' })
    expect(ran.map((r) => [r.id, r.ok])).toEqual([
      ['p0', true],
      ['p1', false]
    ])
    const refused = runSet(node, { ...at, probes: probes('process.exit(0)', 'process.exit(0)'), sanity: 'process.stderr.write("cannot"); process.exit(9)' })
    expect(refused.map((r) => [r.id, r.refused, r.ok])).toEqual([
      ['p0', true, false],
      ['p1', true, false]
    ])
    expect(refused[0].out).toBe('cannot')
    expect(verdict({ ok: true }, refused[0])).toBe('refused')
  })
})

describe('PROBES', () => {
  it('has the probes S2 asks about', () => {
    expect(PROBES.map((p) => p.id)).toEqual([
      'write-workspace',
      'write-tmp',
      'write-home',
      'read-home',
      'read-ssh',
      'read-aws',
      'read-gh',
      'git-credential',
      'keychain',
      'network',
      'loopback',
      'git-commit',
      'git-commit-worktree',
      'git-hooks-write',
      'git-config-write',
      'npm-install'
    ])
    for (const p of PROBES) expect(typeof p.line, p.id).toBe('string')
  })
})

describe('probeTable', () => {
  it('writes one row per probe and one column per set', () => {
    const plain = [{ id: 'read-ssh', ok: true }, { id: 'network', ok: true }]
    const table = probeTable('t', plain, {
      codex: [{ id: 'read-ssh', ok: false }, { id: 'network', ok: true }],
      srt: [{ id: 'read-ssh', ok: true }, { id: 'network', ok: false, timedOut: true }]
    })
    expect(table).toContain('| probe | codex | srt |')
    expect(table).toContain('| read-ssh | denied | allowed |')
    expect(table).toContain('| network | allowed | timeout |')
    expect(table.startsWith('### t\n')).toBe(true)
  })
})
