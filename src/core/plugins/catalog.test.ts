import { describe, it, expect } from 'vitest'
import { CATALOG_ARTIFACT_MAX_BYTES, entryMismatch, isExpired, isRevoked, latestCompatible, parseCatalog, type Catalog, type CatalogEntry } from './catalog'
import type { PluginManifest } from './manifest'

const SHA = 'a'.repeat(64)
const version = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '0.1.0',
  asteraRange: '>=1.5.0 <2.0.0',
  artifactUrl: 'https://example.invalid/hello-0.1.0.tgz',
  sha256: SHA,
  sizeBytes: 1024,
  permissions: ['commands.register', 'panels.register'],
  releaseNotes: 'First',
  ...over
})
const plugin = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'astera-hello-panel',
  publisher: 'example',
  name: 'Hello Panel',
  category: 'development',
  trustLevel: 'restricted-ui',
  license: 'Apache-2.0',
  sourceUrl: 'https://example.invalid/hello',
  versions: [version()],
  ...over
})
const index = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, sequence: 3, expires: '2027-01-01T00:00:00Z', plugins: [plugin()], ...over })
const ok = (text: string): Catalog => {
  const r = parseCatalog(text)
  if (!r.ok) throw new Error(r.problems.join('; '))
  return r.catalog
}
const problems = (text: string): string[] => {
  const r = parseCatalog(text)
  if (r.ok) throw new Error('expected problems')
  return r.problems
}

// Phase 4 (spec M2): the signed index's contents, read by the same rules in the Host, the CLI and the app
describe('parseCatalog', () => {
  it('reads an index of plugins, each with exact versions', () => {
    const c = ok(index())
    expect(c.sequence).toBe(3)
    expect(c.expires).toBe(Date.parse('2027-01-01T00:00:00Z'))
    expect(c.plugins[0]).toMatchObject({ id: 'astera-hello-panel', publisher: 'example', name: 'Hello Panel', category: 'development', trustLevel: 'restricted-ui' })
    expect(c.plugins[0].versions[0]).toMatchObject({ version: '0.1.0', sha256: SHA, sizeBytes: 1024, permissions: ['commands.register', 'panels.register'] })
    expect(c.revoked).toEqual([])
  })

  it('refuses what is not an index this Astera reads', () => {
    expect(problems('not json')).toEqual(['the index is not JSON'])
    expect(problems(index({ schemaVersion: 2 }))).toContain('schemaVersion 2 is not one this Astera reads (1)')
    expect(problems(index({ sequence: 0 }))).toContain('sequence must be a whole number of 1 or more')
    expect(problems(index({ expires: 'soon' }))).toContain('expires must be a date and time')
  })

  it('refuses a plugin entry with a bad id, category, trust level or address, and a repeated id', () => {
    expect(problems(index({ plugins: [plugin({ id: 'Bad Id' })] })).some((p) => p.startsWith('plugins: Bad Id'))).toBe(true)
    expect(problems(index({ plugins: [plugin({ category: 'games' })] }))).toContain('plugins: astera-hello-panel: category games is not one of development, agents, devops, themes, quality')
    expect(problems(index({ plugins: [plugin({ trustLevel: 'sandboxed' })] }))).toContain('plugins: astera-hello-panel: trustLevel sandboxed is not one of trusted, restricted-ui, declarative')
    expect(problems(index({ plugins: [plugin({ sourceUrl: 'http://example.invalid/x' })] }))).toContain('plugins: astera-hello-panel: sourceUrl must be an https address')
    expect(problems(index({ plugins: [plugin(), plugin()] }))).toContain('plugins names astera-hello-panel twice')
  })

  it('refuses a version that is not an exact, https, hashed and sized artifact, and a repeated version', () => {
    const at = (v: Record<string, unknown>): string[] => problems(index({ plugins: [plugin({ versions: [version(v)] })] }))
    expect(at({ version: 'latest' })).toContain('plugins: astera-hello-panel: version latest is not a semver version')
    expect(at({ artifactUrl: 'http://example.invalid/x.tgz' })).toContain('plugins: astera-hello-panel 0.1.0: artifactUrl must be an https address or a path beside the index')
    for (const bad of ['../x.tgz', 'a/../../x.tgz', '/abs/x.tgz', 'C:/x.tgz', 'file:///x.tgz', 'a\\x.tgz'])
      expect(at({ artifactUrl: bad }), bad).toContain('plugins: astera-hello-panel 0.1.0: artifactUrl must be an https address or a path beside the index')
    expect(at({ sha256: 'abc' })).toContain('plugins: astera-hello-panel 0.1.0: sha256 must be 64 lower-case hex characters')
    expect(at({ sizeBytes: CATALOG_ARTIFACT_MAX_BYTES + 1 })).toContain(`plugins: astera-hello-panel 0.1.0: sizeBytes must be a whole number from 1 to ${CATALOG_ARTIFACT_MAX_BYTES}`)
    expect(at({ asteraRange: '^1.5.0' })).toContain('plugins: astera-hello-panel 0.1.0: asteraRange ^1.5.0 is not a range Astera reads')
    expect(at({ permissions: 'all' })).toContain('plugins: astera-hello-panel 0.1.0: permissions must be a list of names')
    expect(problems(index({ plugins: [plugin({ versions: [version(), version()] })] }))).toContain('plugins: astera-hello-panel names version 0.1.0 twice')
  })

  // A static registry keeps its artifacts beside its index: a path resolved against the index's own address
  it('takes an artifact path beside the index', () => {
    expect(ok(index({ plugins: [plugin({ versions: [version({ artifactUrl: 'artifacts/hello-0.1.0.tgz' })] })] })).plugins[0].versions[0].artifactUrl).toBe('artifacts/hello-0.1.0.tgz')
  })

  it('reads revocations of one version or of every version', () => {
    const c = ok(index({ revoked: [{ id: 'astera-hello-panel', version: '0.1.0', reason: 'leaks a token' }, { id: 'astera-bad', version: '*', reason: 'malware' }] }))
    expect(isRevoked(c, 'astera-hello-panel', '0.1.0')).toBe('leaks a token')
    expect(isRevoked(c, 'astera-hello-panel', '0.2.0')).toBeNull()
    expect(isRevoked(c, 'astera-bad', '9.9.9')).toBe('malware')
    expect(problems(index({ revoked: [{ id: 'x', version: 'soon', reason: 'r' }] }))).toContain('revoked: x: version soon must be a semver version or *')
  })
})

describe('latestCompatible', () => {
  const entry = (versions: Record<string, unknown>[]): CatalogEntry => ok(index({ plugins: [plugin({ versions })] })).plugins[0]
  it('picks the highest version this Astera runs, never a revoked one', () => {
    const e = entry([version({ version: '0.1.0' }), version({ version: '0.3.0', asteraRange: '>=1.9.0' }), version({ version: '0.2.0' })])
    expect(latestCompatible(e, '1.5.5', () => null)?.version).toBe('0.2.0')
    expect(latestCompatible(e, '1.9.0', () => null)?.version).toBe('0.3.0')
    expect(latestCompatible(e, '1.5.5', (v) => (v === '0.2.0' ? 'bad' : null))?.version).toBe('0.1.0')
    expect(latestCompatible(e, '1.0.0', () => null)).toBeNull()
  })
})

describe('isExpired', () => {
  it('says an index past its expiry is expired', () => {
    const c = ok(index())
    expect(isExpired(c, Date.parse('2026-12-31T00:00:00Z'))).toBe(false)
    expect(isExpired(c, Date.parse('2027-01-02T00:00:00Z'))).toBe(true)
  })
})

describe('entryMismatch', () => {
  const c = ok(index())
  const e = c.plugins[0]
  const v = e.versions[0]
  const manifest = (over: Partial<PluginManifest> = {}): PluginManifest =>
    ({ id: 'astera-hello-panel', name: 'astera-hello-panel', displayName: 'Hello', version: '0.1.0', apiVersion: '2', capabilities: [], permissions: ['commands.register'], contributes: { commands: [], panels: [] }, trust: 'restricted-ui', settings: [], ...over }) as PluginManifest

  it('takes a package that is the entry: same id, version and trust, asking for no more than it lists', () => {
    expect(entryMismatch(manifest(), e, v)).toBeNull()
  })

  it('names what differs', () => {
    expect(entryMismatch(manifest({ id: 'other' }), e, v)).toBe('the package is other, the catalog lists astera-hello-panel')
    expect(entryMismatch(manifest({ version: '0.1.1' }), e, v)).toBe('the package is version 0.1.1, the catalog lists 0.1.0')
    expect(entryMismatch(manifest({ trust: 'trusted' }), e, v)).toBe('the package is trusted, the catalog lists it as restricted-ui')
    expect(entryMismatch(manifest({ permissions: ['commands.register', 'workspace.read'] }), e, v)).toBe('the package asks for workspace.read, which the catalog does not list')
  })
})
