import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { LSP_SERVERS, languageOf, pyrightConfiguration, pythonPathFor, serverPackages, typescriptServerFor } from './servers'

// Phase 3 Part 3: the pinned servers (measured 2026-11-26; the person's option 2), which one checks a project, and
// pyright's interpreter rules
describe('serverPackages', () => {
  it('gives the win32-x64 TypeScript 7 package and none for an unknown platform', () => {
    expect(serverPackages('typescript', 'win32', 'x64')).toEqual([
      {
        name: '@typescript/typescript-win32-x64',
        version: '7.0.2',
        integrity: 'sha512-0BQ3HkAHHlKLSp1qRvf3SUhGpGsDuhB/jgFw75guyqbxJqEaS0Cw/VFO8i2nHglJUzQCRtMMR/IBAKE3ETMC4g==',
        licence: 'Apache-2.0',
        bytes: 28365027
      }
    ])
    expect(serverPackages('typescript', 'darwin', 'arm64')?.[0].name).toBe('@typescript/typescript-darwin-arm64')
    expect(serverPackages('typescript', 'freebsd', 'x64')).toBeNull()
    expect(serverPackages('typescript', 'win32', 'ia32')).toBeNull()
  })

  it('gives typescript-language-server and typescript 5.9.3 for typescript5, and pyright for python, on any platform', () => {
    expect(serverPackages('typescript5', 'freebsd', 'x64')?.map((p) => [p.name, p.version, p.integrity])).toEqual([
      ['typescript-language-server', '6.1.0', 'sha512-/O/dr2CbvDS1W9jKJcBQxk4WagUQ97oBb8k/eq9cOslsbtAuC2BDPpkcULxE2SEZiPIJvVNLeNjLZe9hQl1zCQ=='],
      ['typescript', '5.9.3', 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==']
    ])
    expect(serverPackages('python', 'linux', 'x64')).toEqual([
      { name: 'pyright', version: '1.1.414', integrity: 'sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==', licence: 'MIT', bytes: 19457120 }
    ])
  })
})

describe('languageOf', () => {
  it('maps extensions to languages, in any case', () => {
    for (const p of ['F:\\a\\B.TSX', 'a.ts', 'a.mts', 'a.cts', 'x.js', 'x.JSX', 'x.mjs', 'x.cjs']) expect(languageOf(p), p).toBe('typescript')
    for (const p of ['m.py', 'stub.PyI']) expect(languageOf(p), p).toBe('python')
    for (const p of ['a.json', 'Makefile', 'a.ts.bak', '.ts']) expect(languageOf(p), p).toBeNull()
    expect(LSP_SERVERS.typescript5.title).toBe('TypeScript 5')
    expect(LSP_SERVERS.python.language).toBe('python')
  })
})

describe('typescriptServerFor', () => {
  it('checks a TS 5 project with typescript5 when installed, else with TS 7 and a note', () => {
    expect(typescriptServerFor(5, new Set(['typescript', 'typescript5']))).toEqual({ server: 'typescript5', notes: [] })
    expect(typescriptServerFor(4, new Set(['typescript5']))).toEqual({ server: 'typescript5', notes: [] })
    expect(typescriptServerFor(5, new Set(['typescript']))).toEqual({ server: 'typescript', notes: ['typescript5-not-installed'] })
    expect(typescriptServerFor(7, new Set(['typescript', 'typescript5']))).toEqual({ server: 'typescript', notes: [] })
    expect(typescriptServerFor(6, new Set(['typescript5']))).toEqual({ server: 'typescript', notes: [] })
    expect(typescriptServerFor(null, new Set(['typescript5']))).toEqual({ server: 'typescript', notes: [] })
  })
})

describe('pyright interpreter rules', () => {
  const prof = path.resolve('prof')
  const none = path.join(prof, 'language-servers', 'no-python', 'python')
  it('never gives pyright a bare or batch interpreter', () => {
    expect(pythonPathFor(null, prof)).toEqual({ pythonPath: none, missingImportsOff: true })
    expect(pythonPathFor(path.resolve('py', 'python3.BAT'), prof)).toEqual({ pythonPath: none, missingImportsOff: true })
    expect(pythonPathFor(path.resolve('py', 'python.cmd'), prof)).toEqual({ pythonPath: none, missingImportsOff: true })
    expect(pythonPathFor('python', prof)).toEqual({ pythonPath: none, missingImportsOff: true })
    const exe = path.resolve('py', 'python.exe')
    expect(pythonPathFor(exe, prof, () => true)).toEqual({ pythonPath: exe, missingImportsOff: false })
  })

  // An interpreter the person set that is not there: pyright could not run it, and its missing-import problems would be
  // false ones
  it('treats an interpreter that does not exist as none', () => {
    expect(pythonPathFor(path.resolve('gone', 'python.exe'), prof, () => false)).toEqual({ pythonPath: none, missingImportsOff: true })
  })

  it('answers only the python section', () => {
    expect(pyrightConfiguration('python', { pythonPath: '/p', missingImportsOff: true })).toEqual({
      pythonPath: '/p',
      analysis: { autoSearchPaths: true, diagnosticSeverityOverrides: { reportMissingImports: 'none', reportMissingModuleSource: 'none' } }
    })
    expect(pyrightConfiguration('python', { pythonPath: '/p', missingImportsOff: false })).toEqual({ pythonPath: '/p', analysis: { autoSearchPaths: true } })
    expect(pyrightConfiguration('pyright', { pythonPath: '/p', missingImportsOff: true })).toBeNull()
    expect(pyrightConfiguration('js/ts', { pythonPath: '/p', missingImportsOff: true })).toBeNull()
  })
})
