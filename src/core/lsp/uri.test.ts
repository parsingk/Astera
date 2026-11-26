import { describe, it, expect } from 'vitest'
import { pathToUri, uriToPath } from './uri'

// Phase 3 Part 3: file URIs for language servers. TypeScript 7 answers `file:///f%3A/...` for a document opened as
// `file:///F:/...` (measured 2026-11-26), so both read back to one path.
describe('pathToUri and uriToPath', () => {
  it('writes a Windows path as file:///F:/... with spaces, Hangul, % and # encoded', () => {
    expect(pathToUri('F:\\a b\\한 %#.ts', 'win32')).toBe('file:///F:/a%20b/%ED%95%9C%20%25%23.ts')
    expect(pathToUri('f:/x/y.ts', 'win32')).toBe('file:///F:/x/y.ts')
  })

  it('reads both drive forms back to one path', () => {
    expect(uriToPath('file:///f%3A/a/b.ts', 'win32')).toBe('F:\\a\\b.ts')
    expect(uriToPath('file:///F:/a/b.ts', 'win32')).toBe('F:\\a\\b.ts')
    expect(uriToPath('file:///F:/a%20b/%ED%95%9C%20%25%23.ts', 'win32')).toBe('F:\\a b\\한 %#.ts')
  })

  it('refuses UNC and device paths both ways', () => {
    for (const p of ['\\\\srv\\share\\a.ts', '\\\\?\\C:\\a.ts', '\\\\.\\C:\\a.ts', '//srv/share/a.ts']) expect(pathToUri(p, 'win32'), p).toBeNull()
    expect(uriToPath('file://srv/share/a.ts', 'win32')).toBeNull()
    expect(uriToPath('file:////srv/share/a.ts', 'win32')).toBeNull()
    expect(pathToUri('relative\\a.ts', 'win32')).toBeNull()
    expect(uriToPath('untitled:Untitled-1', 'win32')).toBeNull()
    expect(uriToPath('file:///F:/a%E0%A4%A.ts', 'win32')).toBeNull()
  })

  it('round-trips a posix path', () => {
    const uri = pathToUri('/home/u/a b.py', 'linux')
    expect(uri).toBe('file:///home/u/a%20b.py')
    expect(uriToPath(uri as string, 'linux')).toBe('/home/u/a b.py')
    expect(pathToUri('//srv/a.py', 'linux')).toBeNull()
  })
})
