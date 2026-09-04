import { describe, it, expect } from 'vitest'
import { runnableKindForFile, configForFile, MAX_TEMPORARY } from './runFile'

describe('runnableKindForFile', () => {
  it('reads Python', () => {
    expect(runnableKindForFile('seed.py')).toBe('python')
  })

  // A test file is a test file: the pytest rules are tried before the plain .py rule.
  it('reads a pytest file before a plain Python one', () => {
    expect(runnableKindForFile('test_seed.py')).toBe('pytest')
    expect(runnableKindForFile('seed_test.py')).toBe('pytest')
  })

  it('reads the three Node extensions', () => {
    expect(runnableKindForFile('serve.js')).toBe('node')
    expect(runnableKindForFile('serve.mjs')).toBe('node')
    expect(runnableKindForFile('serve.cjs')).toBe('node')
  })

  it('reads every compose file name', () => {
    for (const n of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
      expect(runnableKindForFile(n), n).toBe('compose')
    }
  })

  it('reads the .NET project files', () => {
    expect(runnableKindForFile('Api.csproj')).toBe('dotnet')
    expect(runnableKindForFile('Api.fsproj')).toBe('dotnet')
    expect(runnableKindForFile('Api.sln')).toBe('dotnet')
  })

  // Each exclusion is a decision, not an omission — see the spec's §3.
  it.each([
    ['Dockerfile'],
    ['Dockerfile.dev'],
    ['serve.ts'],
    ['package.json'],
    ['build.gradle'],
    ['build.gradle.kts'],
    ['pom.xml'],
    ['README.md'],
    ['LICENSE'],
    ['']
  ])('offers nothing for %s', (name) => {
    expect(runnableKindForFile(name)).toBeNull()
  })
})

describe('configForFile', () => {
  it("fills the kind's own field, not a generic one", () => {
    expect(configForFile('scripts/seed.py', 'i', 'seed.py')).toEqual({
      id: 'i', name: 'seed.py', type: 'python', file: 'scripts/seed.py'
    })
    expect(configForFile('tests/test_seed.py', 'i', 'test_seed.py')).toEqual({
      id: 'i', name: 'test_seed.py', type: 'pytest', target: 'tests/test_seed.py'
    })
    expect(configForFile('serve.js', 'i', 'serve.js')).toEqual({
      id: 'i', name: 'serve.js', type: 'node', file: 'serve.js'
    })
    expect(configForFile('docker-compose.yml', 'i', 'docker-compose.yml')).toEqual({
      id: 'i', name: 'docker-compose.yml', type: 'compose', composeFile: 'docker-compose.yml'
    })
    expect(configForFile('src/Api.csproj', 'i', 'Api.csproj')).toEqual({
      id: 'i', name: 'Api.csproj', type: 'dotnet', project: 'src/Api.csproj'
    })
  })

  // The inference reads the basename; the stored path is the whole relative path it was given.
  it('keeps the path it was given, not the basename', () => {
    expect(configForFile('a/b/c/seed.py', 'i', 'seed.py')).toMatchObject({ file: 'a/b/c/seed.py' })
  })

  it('is null for a file no kind can be inferred from', () => {
    expect(configForFile('Dockerfile', 'i', 'Dockerfile')).toBeNull()
  })

  it("does not mark the configuration temporary — that is the caller's decision", () => {
    expect(configForFile('seed.py', 'i', 'seed.py')).not.toHaveProperty('temporary')
  })
})

describe('MAX_TEMPORARY', () => {
  it('is five', () => {
    expect(MAX_TEMPORARY).toBe(5)
  })
})
