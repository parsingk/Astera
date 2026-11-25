import { describe, it, expect } from 'vitest'
import {
  CONTEXT_DATA_LINE as DATA_LINE,
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
  const at = (cwd: string, more: { alive?: boolean } = {}) => ({ cwd, alive: more.alive ?? true })

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

  it('refuses a session that has ended', () => {
    expect(sessionFits(ref(), at('D:\\repo', { alive: false }))).toBe(false)
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
        DATA_LINE,
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
    expect(r.text).toBe(['## Context from Astera: log', '**Source:** Run: npm run dev', DATA_LINE, '', '```', 'error: boom', '```', ''].join('\n'))
  })
})

const ESC = String.fromCharCode(27)

describe('maskForAgent, the shapes a file selection holds (review I2)', () => {
  const masked = (text: string): number => maskForAgent(text).masked
  it('masks values under quoted secret keys, as JSON, YAML and Python write them', () => {
    expect(masked('{ "password": "Sup3rS3cretPassw0rd!x" }')).toBe(1)
    expect(masked('"client_secret": "Zx9Qw8Er7Ty6Ui5Op4As"')).toBe(1)
    expect(masked('"apiKey": "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"')).toBe(1)
    expect(masked("{'api_key': 'Zx9Qw8Er7Ty6Ui5Op4As'}")).toBe(1)
    expect(maskForAgent('"password": "Sup3rS3cretPassw0rd!x"').text).toBe('"password": "[REDACTED]"')
  })

  it('masks environment values whose names end in KEY, SECRET, TOKEN or PASSWORD', () => {
    expect(masked('STRIPE_KEY=sk_live_51HxQwErTyUiOp')).toBe(1)
    expect(masked('PRIVATE_KEY=Zx9Qw8Er7Ty6Ui5Op4As')).toBe(1)
    expect(masked('KEY=Zx9Qw8Er7Ty6Ui5Op4As')).toBe(1)
    expect(maskForAgent('DB_PASSWORD="Zx9Qw8Er7Ty6Ui5Op4As"').text).toBe('DB_PASSWORD=[REDACTED]')
  })

  it('masks a private key block, whole or cut off by the selection, and a Slack webhook', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAx', 'abcdEFGH1234', '-----END RSA PRIVATE KEY-----'].join('\n')
    const r = maskForAgent(`before\n${pem}\nafter`)
    expect(r.text).toBe('before\n-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]\n-----END RSA PRIVATE KEY-----\nafter')
    expect(r.masked).toBe(1)
    expect(maskForAgent('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq').text).not.toContain('MIIEvQIBADANBgkq')
    expect(masked('url = https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXX')).toBe(1)
  })

  it('masks the sk- and KEY= shapes the plan names, and still leaves prose and short words alone', () => {
    expect(masked('OPENAI_API_KEY=sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78')).toBe(1)
    expect(masked('{ "token_type": "bearer", "keyword": "search" }')).toBe(0)
    expect(masked('MONKEY=banana')).toBe(0)
  })
})

describe('contextText, the text as it is pasted', () => {
  // Review C2: an ESC[201~ in a file ended the bracketed paste early, so the next line break pressed Enter.
  it('drops control characters other than tab and line breaks, and counts them', () => {
    const r = contextText(ref(), `const a = 1 // ${ESC}[201~\nnext line\tend${String.fromCharCode(127)}`)
    expect(r.text).not.toContain(ESC)
    expect(r.text).not.toContain(String.fromCharCode(127))
    expect(r.text).toContain('const a = 1 // [201~\nnext line\tend')
    expect(r.stripped).toBe(2)
  })

  // Review I6: spec W4 treats logs and plugin text as data, never as commands.
  it('says the excerpt is data, not instructions', () => {
    expect(contextText(ref(), 'x').text).toContain(DATA_LINE)
  })

  // Review M1: a token across the character cap left its start unmasked.
  it('masks before it cuts, so a token at the cap is not half shown', () => {
    const r = contextText(ref(), 'x'.repeat(CONTEXT_EXCERPT_CHARS - 6) + ' ' + GH)
    expect(r.text).not.toContain('ghp_')
  })

  // Review I4: a log is sent for its end; long lines made the character cap drop the error on the last line.
  it('keeps the end of a log when asked, by lines and by characters, and words the cut for it', () => {
    const lines = Array.from({ length: 199 }, (_, i) => `${i} ${'.'.repeat(95)}`)
    const r = contextText(ref({ kind: 'log', path: undefined, range: undefined }), [...lines, 'ERROR: Cannot find module ./config'].join('\n'), '', { keepEnd: true })
    expect(r.cut).toBe(true)
    expect(r.text).toContain('ERROR: Cannot find module ./config')
    expect(r.text).toContain('(cut: only the last')
    const many = Array.from({ length: CONTEXT_EXCERPT_LINES + 20 }, (_, i) => `l${i}`).join('\n')
    const byLines = contextText(ref(), many, '', { keepEnd: true })
    expect(byLines.text).toContain(`l${CONTEXT_EXCERPT_LINES + 19}`)
    expect(byLines.text).not.toContain('l0\n')
    expect(byLines.text).toContain(`(cut: the last ${CONTEXT_EXCERPT_LINES} of ${CONTEXT_EXCERPT_LINES + 20} lines are shown)`)
  })

  // Review M2: the cut note was wrong for one long line and for whole lines ending in a line break.
  it('says nothing was cut for exactly the line cap with a final line break, and words a character cut as one', () => {
    const exact = Array.from({ length: CONTEXT_EXCERPT_LINES }, (_, i) => `l${i}`).join('\n') + '\n'
    expect(contextText(ref(), exact).cut).toBe(false)
    const wide = contextText(ref(), 'x'.repeat(CONTEXT_EXCERPT_CHARS + 10))
    expect(wide.text).toContain(`(cut: only the first ${CONTEXT_EXCERPT_CHARS} characters are shown)`)
  })

  // Review M8: the agent reads the disk; lines taken from unsaved edits may not be where it looks.
  it('tells the agent when the excerpt comes from unsaved edits', () => {
    expect(contextText(ref(), 'x', 'ts', { dirty: true }).text).toContain('**Note:** taken from unsaved edits in the editor')
    expect(contextText(ref(), 'x', 'ts').text).not.toContain('**Note:**')
  })
})
