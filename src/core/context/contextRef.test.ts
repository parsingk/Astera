import { describe, it, expect } from 'vitest'
import {
  CONTEXT_EXCERPT_CHARS,
  CONTEXT_EXCERPT_LINES,
  contentRevision,
  contextText,
  isUnder,
  maskForAgent,
  sessionFits,
  type ContextRef
} from './contextRef'

const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

describe('maskForAgent', () => {
  it('masks tokens, key=value secrets, Bearer values and URL passwords, and counts them', () => {
    const r = maskForAgent(`const t = "${GH}"\napi_key=Zx9Qw8Er7Ty6Ui5Op4As\nAuthorization: Bearer abcDEF123456ghiJKL789\ngit clone https://me:hunter2pass@example.com/r.git`)
    expect(r.text).not.toContain(GH)
    expect(r.text).not.toContain('Zx9Qw8Er7Ty6Ui5Op4As')
    expect(r.text).not.toContain('abcDEF123456ghiJKL789')
    expect(r.text).not.toContain('hunter2pass')
    expect(r.text).toContain('https://me:[REDACTED]@example.com')
    expect(r.masked).toBe(4)
  })

  // The redactor tab briefings and Slack share: prose about tokens stays prose.
  it('leaves prose and ordinary code untouched', () => {
    const prose = 'Fixed the token: it was being dropped by the interceptor.\nconst tokenCount = items.length'
    expect(maskForAgent(prose)).toEqual({ text: prose, masked: 0 })
  })

  it('does not count a [REDACTED] that was already in the text', () => {
    expect(maskForAgent('already [REDACTED] here').masked).toBe(0)
  })
})

describe('contentRevision', () => {
  it('is stable for the same text and differs for another', () => {
    expect(contentRevision('abc')).toBe(contentRevision('abc'))
    expect(contentRevision('abc')).not.toBe(contentRevision('abd'))
    expect(contentRevision('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('isUnder', () => {
  it('takes a folder and what is below it, not a sibling that starts with its name', () => {
    expect(isUnder('D:\\p', 'D:\\p')).toBe(true)
    expect(isUnder('D:\\p', 'D:\\p\\src\\a.ts')).toBe(true)
    expect(isUnder('D:\\p\\', 'D:\\p\\a.ts')).toBe(true)
    expect(isUnder('D:\\p', 'D:\\p2\\a.ts')).toBe(false)
    expect(isUnder('/home/u/p', '/home/u/p/a')).toBe(true)
    expect(isUnder('/home/u/p', '/home/u/pa')).toBe(false)
  })

  it('reads slashes either way, and drive-letter paths without regard to case', () => {
    expect(isUnder('d:/P', 'D:\\p\\a.ts')).toBe(true)
    expect(isUnder('/home/U', '/home/u/a')).toBe(false)
  })
})

const ref = (over: Partial<ContextRef> = {}): ContextRef => ({
  schemaVersion: 1,
  kind: 'selection',
  root: 'D:\\repo',
  path: 'D:\\repo\\src\\a.ts',
  range: { startLine: 3, endLine: 5 },
  revision: 'deadbeef',
  label: 'src/a.ts:3-5',
  ...over
})

describe('sessionFits', () => {
  const at = (cwd: string, more: { alive?: boolean; remote?: boolean } = {}) => ({ cwd, alive: more.alive ?? true, ...(more.remote ? { remote: true } : {}) })

  it('takes a live local session working in the project, or in a folder of it that holds the file', () => {
    expect(sessionFits(ref(), at('D:\\repo'))).toBe(true)
    expect(sessionFits(ref(), at('D:\\repo\\src'))).toBe(true)
  })

  // Spec W4: another worktree's reference is refused.
  it('refuses a session of another worktree, whose folder is outside the project or does not hold the file', () => {
    expect(sessionFits(ref(), at('F:\\worktrees\\repo-feature'))).toBe(false)
    expect(sessionFits(ref({ root: 'F:\\worktrees\\x', path: 'F:\\worktrees\\x\\a.ts' }), at('D:\\repo'))).toBe(false)
    expect(sessionFits(ref(), at('D:\\repo\\docs'))).toBe(false)
  })

  it('refuses a session that has ended, or one on another computer', () => {
    expect(sessionFits(ref(), at('D:\\repo', { alive: false }))).toBe(false)
    expect(sessionFits(ref(), at('D:\\repo', { remote: true }))).toBe(false)
  })

  it('takes a log, which has no file, for any session in the project', () => {
    const log = ref({ kind: 'log', path: undefined, range: undefined, label: 'npm run dev' })
    expect(sessionFits(log, at('D:\\repo\\sub'))).toBe(true)
    expect(sessionFits(log, at('E:\\other'))).toBe(false)
  })
})

describe('contextText', () => {
  it('names the kind, the file and its lines, and the revision, then the excerpt in a fenced block', () => {
    const r = contextText(ref(), 'const a = 1\nconst b = 2\nconst c = 3', 'ts')
    expect(r.cut).toBe(false)
    expect(r.masked).toBe(0)
    expect(r.text).toBe(
      [
        '## Context from Astera: selection',
        '**File:** src/a.ts (lines 3-5)',
        '**Revision:** deadbeef',
        '',
        '```ts',
        'const a = 1',
        'const b = 2',
        'const c = 3',
        '```',
        ''
      ].join('\n')
    )
  })

  it('makes the fence longer than any run of backticks in the excerpt', () => {
    const r = contextText(ref(), 'a ``` b\nc ```` d')
    expect(r.text).toContain('`````\na ``` b\nc ```` d\n`````')
  })

  it('cuts the excerpt at the line cap and at the character cap, and says so', () => {
    const many = Array.from({ length: CONTEXT_EXCERPT_LINES + 50 }, (_, i) => `line ${i}`).join('\n')
    const byLines = contextText(ref(), many)
    expect(byLines.cut).toBe(true)
    expect(byLines.text).toContain(`line ${CONTEXT_EXCERPT_LINES - 1}`)
    expect(byLines.text).not.toContain(`line ${CONTEXT_EXCERPT_LINES}\n`)
    expect(byLines.text).toContain('(cut:')
    const wide = contextText(ref(), 'x'.repeat(CONTEXT_EXCERPT_CHARS + 500))
    expect(wide.cut).toBe(true)
    expect(wide.text.length).toBeLessThan(CONTEXT_EXCERPT_CHARS + 400)
  })

  it('masks the excerpt and counts what it masked', () => {
    const r = contextText(ref(), `token=${GH}`)
    expect(r.text).not.toContain(GH)
    expect(r.masked).toBe(1)
  })

  it('writes a log with its source and no file line', () => {
    const r = contextText(ref({ kind: 'log', path: undefined, range: undefined, revision: undefined, label: 'Run: npm run dev' }), 'error: boom')
    expect(r.text).toBe(['## Context from Astera: log', '**Source:** Run: npm run dev', '', '```', 'error: boom', '```', ''].join('\n'))
  })
})
