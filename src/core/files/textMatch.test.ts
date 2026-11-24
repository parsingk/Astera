import { describe, it, expect } from 'vitest'
import { isCredentialFile, looksBinary, matchLines, textSearchPattern, TEXT_PREVIEW_CHARS } from './textMatch'

const rows = (text: string, query: string, room = 100) => matchLines(text, textSearchPattern(query), room)

describe('matchLines', () => {
  it('answers one row per line, 1-based, with every match on it', () => {
    expect(rows('a\nfoo bar foo\nbaz', 'foo')).toEqual([{ line: 2, col: 1, preview: 'foo bar foo', ranges: [[0, 3], [8, 11]] }])
  })

  it('counts lines across several matching lines and leaves a line ending out of the preview', () => {
    expect(rows('x Foo\r\n\r\nFOO y\r\n', 'foo')).toEqual([
      { line: 1, col: 3, preview: 'x Foo', ranges: [[2, 5]] },
      { line: 3, col: 1, preview: 'FOO y', ranges: [[0, 3]] }
    ])
  })

  // The editor's buffer is toLf(content) (core/files/edit.ts): `\r\n`, a lone `\r` and `\n` each end a line. A file
  // converted to CRLF twice (`\r\r\n`) is a real artifact of autocrlf and an editor, and Enter must land on its line.
  it('ends a line at a lone CR as the editor does, as well as at CRLF and LF', () => {
    expect(rows('a\r\r\nb\r\r\nc hit', 'hit')).toEqual([{ line: 5, col: 3, preview: 'c hit', ranges: [[2, 5]] }])
    expect(rows('one\r\rtwo\r\r\nthree hit', 'hit')).toEqual([{ line: 5, col: 7, preview: 'three hit', ranges: [[6, 9]] }])
    expect(rows('x\ry hit\nz hit', 'hit').map((r) => r.line)).toEqual([2, 3])
  })

  // Review M3: a minified line with tens of thousands of matches built tuples that the window then threw away, all on
  // main's thread. Matches past the window are not collected, and the next line is still found.
  it('stops collecting a line\'s matches past its window, and still finds the lines after it', () => {
    /** The pattern textSearchPattern makes, counting how often it is run. */
    class Counting extends RegExp {
      calls = 0
      exec(s: string): RegExpExecArray | null {
        this.calls++
        return super.exec(s)
      }
    }
    const pattern = new Counting(textSearchPattern('e').source, 'giu')
    const found = matchLines(`${'e'.repeat(300_000)}\nnext e`, pattern, 10)
    expect(found).toHaveLength(2)
    expect(found[0].ranges.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARS)
    expect(found[1]).toEqual({ line: 2, col: 2, preview: 'next e', ranges: [[1, 2], [5, 6]] })
    expect(pattern.calls).toBeLessThan(TEXT_PREVIEW_CHARS * 2)
  })

  // The editor reads a file with Buffer#toString, which keeps a BOM as the first character of line 1 (files.read), so the
  // column counts it; the preview does not show it.
  it('counts a BOM in the column, as the editor holds it, and does not show it', () => {
    expect(rows('﻿const x = 1', 'const')).toEqual([{ line: 1, col: 2, preview: 'const x = 1', ranges: [[0, 5]] }])
  })

  it('drops indentation from the preview, keeping the column of the line as written', () => {
    expect(rows('\t\t  return value', 'value')).toEqual([{ line: 1, col: 12, preview: 'return value', ranges: [[7, 12]] }])
  })

  it('ignores case, beyond ASCII too, and finds Korean as typed', () => {
    expect(rows('CAFÉ', 'café')[0].ranges).toEqual([[0, 4]])
    expect(rows('// 한글 이름을 찾는다', '이름')).toEqual([{ line: 1, col: 7, preview: '// 한글 이름을 찾는다', ranges: [[6, 8]] }])
  })

  it('takes regular expression characters literally', () => {
    expect(rows('a.b axb (x)+ [y]', 'a.b')[0].ranges).toEqual([[0, 3]])
    expect(rows('a.b axb (x)+ [y]', '(x)+')[0].ranges).toEqual([[8, 12]])
    expect(rows('a.b axb (x)+ [y]', '[y]')[0].ranges).toEqual([[13, 16]])
  })

  // A minified bundle is one very long line: the row shows a window around the first match, says it was cut, and its
  // marks still point at the match.
  it('windows a long line around its first match, with marks on the match', () => {
    const line = 'a'.repeat(5000) + 'NEEDLE' + 'b'.repeat(400_000)
    const [r] = rows(line, 'needle')
    expect(r.col).toBe(5001)
    expect(r.preview.startsWith('…')).toBe(true)
    expect(r.preview.endsWith('…')).toBe(true)
    expect(r.preview.length).toBe(TEXT_PREVIEW_CHARS + 2)
    const [s, e] = r.ranges[0]
    expect(r.preview.slice(s, e)).toBe('NEEDLE')
  })

  it('keeps only the marks inside the window', () => {
    const line = 'x'.repeat(100) + 'hit' + 'y'.repeat(1000) + 'hit'
    const [r] = rows(line, 'hit')
    expect(r.ranges).toHaveLength(1)
    expect(r.preview.slice(r.ranges[0][0], r.ranges[0][1])).toBe('hit')
  })

  it('stops at the room it is given', () => {
    const text = Array.from({ length: 10 }, (_, i) => `hit ${i}`).join('\n')
    expect(rows(text, 'hit', 3).map((r) => r.line)).toEqual([1, 2, 3])
    expect(rows(text, 'hit', 0)).toEqual([])
  })

  it('answers nothing for text without the query, and can be used again on the next file', () => {
    const p = textSearchPattern('z')
    expect(matchLines('abc', p, 5)).toEqual([])
    expect(matchLines('z', p, 5)).toHaveLength(1)
    expect(matchLines('z', p, 5)).toHaveLength(1)
  })
})

describe('looksBinary', () => {
  // The editor's rule (files.read): a NUL anywhere means it shows no text, so search does not list a line in it.
  it('is true for a NUL byte anywhere, and false for text', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false)
    expect(looksBinary(Buffer.concat([Buffer.alloc(20_000, 0x61), Buffer.from([0])]))).toBe(true)
    expect(looksBinary(Buffer.from('한글', 'utf8'))).toBe(false)
  })
})

describe('isCredentialFile', () => {
  it('names files that hold secrets', () => {
    for (const p of [
      '.env', 'app/.env.local', '.env.production', '.envrc', '.npmrc', '.netrc', '_netrc', '.pypirc', '.pgpass', '.htpasswd',
      '.git-credentials', 'credentials.json', '.credentials.json', 'aws/credentials', 'id_rsa', 'keys/id_ed25519',
      'certs/server.pem', 'tls.key', 'store.p12', 'cert.PFX', 'release.jks', 'app.keystore', 'vault.kdbx', 'putty.ppk',
      'home/.ssh/config', '.gnupg/pubring.kbx', '.aws/config',
      // Logins of the tools an Astera user has, found when the explorer's project is the home folder (review M8)
      '.codex/auth.json', '.kube/config', '.kube/cache/discovery/x.json', '.docker/config.json', '.config/gh/hosts.yml'
    ]) {
      expect(isCredentialFile(p), p).toBe(true)
    }
  })

  it('leaves templates and ordinary files alone', () => {
    for (const p of [
      '.env.example', '.env.sample', 'web/.env.template', '.env.dist', '.env.defaults', 'id_rsa.pub', 'src/keys.ts',
      'docs/credentials.md', 'src/core/credentials/store.ts', 'environment.ts', 'monkey.ts', 'README.md', 'cert.crt',
      'src/auth.json', '.docker/nginx/default.conf', 'docker/config.json', 'gh/hosts.ts'
    ]) {
      expect(isCredentialFile(p), p).toBe(false)
    }
  })
})
