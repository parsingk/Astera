import { describe, it, expect } from 'vitest'
import {
  argsOfLine,
  fieldsOfLine,
  lineOfReviewer,
  lineOfArgs,
  probeText,
  reviewerChipName,
  externalNameOf,
  withReviewerAdded,
  withReviewerEdited,
  withReviewerRemoved,
  withoutKey
} from './reviewerSettingsView'
import { MAX_EXTERNAL_REVIEWERS, reviewerSettingsOf, type ExternalReviewer, type ReviewerSettings } from '../../../core/settings/externalReviewers'

const rv = (n: number, over: Partial<ExternalReviewer> = {}): ExternalReviewer => ({
  id: `ext_0000000${n}`,
  name: `Reviewer ${n}`,
  command: 'agent',
  args: ['--acp'],
  ...over
})
const empty: ReviewerSettings = { reviewers: [], reviewBy: null }
const narrowed = (s: ReviewerSettings): ReviewerSettings =>
  reviewerSettingsOf({ externalReviewers: s.reviewers, reviewBy: s.reviewBy })

describe('withReviewerAdded', () => {
  it('adds with a fresh id, trimmed, and the result survives the store narrowing unchanged', () => {
    const r = withReviewerAdded(empty, { name: '  Gemini CLI ', command: ' gemini ', args: ['--acp'] })
    if ('error' in r) throw new Error('unexpected')
    expect(r.reviewers).toHaveLength(1)
    expect(r.reviewers[0]).toMatchObject({ name: 'Gemini CLI', command: 'gemini', args: ['--acp'] })
    expect(r.reviewers[0].id).toMatch(/^ext_[0-9a-f]{8}$/)
    expect(r.reviewBy).toBeNull()
    expect(narrowed(r)).toEqual(r)
  })

  it.each([
    ['empty name', { name: '   ', command: 'x', args: [] as string[] }, 'name'],
    ['41 character name', { name: 'a'.repeat(41), command: 'x', args: [] as string[] }, 'name'],
    ['two-line name', { name: 'a\nb', command: 'x', args: [] as string[] }, 'name'],
    ['empty command', { name: 'A', command: '  ', args: [] as string[] }, 'command'],
    ['two-line command', { name: 'A', command: 'a\nb', args: [] as string[] }, 'command'],
    ['21 args', { name: 'A', command: 'x', args: Array.from({ length: 21 }, () => 'a') }, 'command'],
    // Final fix wave A2: a relative path would run a program from the reviewed folder
    ['a relative command path', { name: 'A', command: './agent', args: [] as string[] }, 'command'],
    ['a relative command path with a backslash', { name: 'A', command: ['bin', 'agent'].join(String.fromCharCode(92)), args: [] as string[] }, 'command']
  ])('refuses %s', (_label, input, error) => {
    expect(withReviewerAdded(empty, input)).toEqual({ error })
  })

  it('accepts a 40 character name and 20 args', () => {
    const r = withReviewerAdded(empty, { name: 'a'.repeat(40), command: 'x', args: Array.from({ length: 20 }, () => 'a') })
    expect('error' in r).toBe(false)
  })

  it('refuses past the limit', () => {
    const full: ReviewerSettings = {
      reviewers: Array.from({ length: MAX_EXTERNAL_REVIEWERS }, (_, i) => rv(i)),
      reviewBy: null
    }
    expect(withReviewerAdded(full, { name: 'A', command: 'x', args: [] })).toEqual({ error: 'limit' })
  })

  it('keeps the choice', () => {
    const s: ReviewerSettings = { reviewers: [rv(1)], reviewBy: rv(1).id }
    const r = withReviewerAdded(s, { name: 'B', command: 'x', args: [] })
    if ('error' in r) throw new Error('unexpected')
    expect(r.reviewBy).toBe(rv(1).id)
    expect(r.reviewers).toHaveLength(2)
  })
})

// Final fix wave E3: a saved edit drops the reviewer's shown Test result
describe('withoutKey', () => {
  it('drops one entry and keeps the rest, leaving the input as it was', () => {
    const results = { a: { ok: true, text: 'x' }, b: { ok: false, text: 'y' } }
    expect(withoutKey(results, 'a')).toEqual({ b: { ok: false, text: 'y' } })
    expect(withoutKey(results, 'c')).toEqual(results)
    expect(results).toHaveProperty('a')
  })
})

describe('withReviewerRemoved', () => {
  it('returns the choice to automatic when the chosen one goes', () => {
    const s: ReviewerSettings = { reviewers: [rv(1), rv(2)], reviewBy: rv(1).id }
    expect(withReviewerRemoved(s, rv(1).id)).toEqual({ reviewers: [rv(2)], reviewBy: null })
  })
  it('keeps the choice when another goes', () => {
    const s: ReviewerSettings = { reviewers: [rv(1), rv(2)], reviewBy: rv(1).id }
    expect(withReviewerRemoved(s, rv(2).id)).toEqual({ reviewers: [rv(1)], reviewBy: rv(1).id })
  })
  it('ignores an unknown id', () => {
    const s: ReviewerSettings = { reviewers: [rv(1)], reviewBy: null }
    expect(withReviewerRemoved(s, 'ext_ffffffff')).toEqual(s)
  })
})

describe('withReviewerEdited', () => {
  it('replaces the reviewer by id, trimmed, keeping the choice', () => {
    const s: ReviewerSettings = { reviewers: [rv(1), rv(2)], reviewBy: rv(2).id }
    const r = withReviewerEdited(s, { ...rv(2), name: ' New ', command: ' cmd ', args: ['a b'] })
    expect(r).toEqual({ reviewers: [rv(1), { ...rv(2), name: 'New', command: 'cmd', args: ['a b'] }], reviewBy: rv(2).id })
    expect(narrowed(r as ReviewerSettings)).toEqual(r)
  })
  it.each([
    [{ name: '', command: 'x' }, 'name'],
    [{ name: 'A', command: '' }, 'command'],
    [{ name: 'A', command: 'tools/agent' }, 'command']
  ])('refuses %j', (over, error) => {
    expect(withReviewerEdited({ reviewers: [rv(1)], reviewBy: null }, { ...rv(1), ...over })).toEqual({ error })
  })
})

describe('args line', () => {
  it.each([
    ['', []],
    ['--acp', ['--acp']],
    ['  acp   --verbose ', ['acp', '--verbose']],
    ['--dir "C:\\My Projects\\x" --flag', ['--dir', 'C:\\My Projects\\x', '--flag']],
    ['--name="a b"', ['--name=a b']],
    ['a "" b', ['a', '', 'b']],
    // A backslash is always a literal character, also right before a closing quote
    ['--root "C:\\Program Files\\x\\" --acp', ['--root', 'C:\\Program Files\\x\\', '--acp']],
    ['--root="C:\\a b\\"', ['--root=C:\\a b\\']],
    // Two quotes in a row inside a quoted section are one quote
    ['"say ""hi""" x', ['say "hi"', 'x']]
  ])('parses %j', (line, args) => {
    expect(argsOfLine(line)).toEqual(args)
  })

  it.each([
    [[]],
    [['--acp']],
    [['--dir', 'C:\\My Projects\\x', '--flag']],
    [['a b', 'c', '']],
    [['--name=a b']],
    [['say "hi"', 'x']],
    [['C:\\Program Files\\x\\']],
    [['a b\\', 'c']],
    [['']],
    [['--k=v w']],
    [['\\\\server\\share\\dir with space\\']],
    [['plain', '--acp']],
    [['"']],
    [['a\\"b']]
  ])('round trips %j', (args) => {
    expect(argsOfLine(lineOfArgs(args))).toEqual(args)
  })

  it('writes an arg with a space in quotes', () => {
    expect(lineOfArgs(['a b', 'c'])).toBe('"a b" c')
  })

  it('leaves a plain arg and a backslash path without spaces unquoted', () => {
    expect(lineOfArgs(['--acp', 'C:\\tools\\agent.cmd'])).toBe('--acp C:\\tools\\agent.cmd')
  })
})

describe('reviewerChipName', () => {
  it('leaves 20 characters alone and cuts longer with an ellipsis', () => {
    expect(reviewerChipName('a'.repeat(20))).toBe('a'.repeat(20))
    expect(reviewerChipName('a'.repeat(21))).toBe('a'.repeat(20) + '…')
  })
})

describe('externalNameOf', () => {
  it('names an external reviewer, an external agent (its id until its name is read), and nothing else', () => {
    expect(externalNameOf({ externalReviewer: { id: 'ext_1', name: 'Gemini CLI' } })).toBe('Gemini CLI')
    expect(externalNameOf({ externalAgent: { id: 'ext_2', name: 'OpenCode' } })).toBe('OpenCode')
    expect(externalNameOf({ externalAgent: { id: 'ext_2', name: '' } })).toBe('ext_2')
    expect(externalNameOf({})).toBeUndefined()
  })
})

describe('probeText', () => {
  const t = (key: string, p?: Record<string, unknown>): string => `${key} ${JSON.stringify(p ?? {})}`
  it('names the agent by title, else name, with the version', () => {
    expect(probeText({ ok: true, agent: { title: 'Gemini', name: 'g', version: '1.2' } }, t as never)).toBe(
      'settings.reviewer.test.ok {"agent":"Gemini 1.2"}'
    )
    expect(probeText({ ok: true, agent: { name: 'g' } }, t as never)).toBe('settings.reviewer.test.ok {"agent":"g"}')
    expect(probeText({ ok: true, agent: {} }, t as never)).toBe('settings.reviewer.test.ok {"agent":""}')
  })
  it.each([
    ['not-found', 'settings.reviewer.test.not-found {}'],
    ['timeout', 'settings.reviewer.test.timeout {}'],
    ['unsupported-version', 'settings.reviewer.test.unsupported-version {}'],
    ['sign-in', 'settings.reviewer.test.sign-in {"message":"m"}'],
    ['exited', 'settings.reviewer.test.failed {"message":"m"}'],
    ['violation', 'settings.reviewer.test.failed {"message":"m"}'],
    ['protocol', 'settings.reviewer.test.failed {"message":"m"}']
  ] as const)('words %s', (kind, text) => {
    expect(probeText({ ok: false, kind, message: 'm' }, t as never)).toBe(text)
  })
})

describe('the command line', () => {
  const WIN = ['C:', 'Program Files', 'g.exe'].join(String.fromCharCode(92))
  it('splits into command and args, and a path with a space stays one command', () => {
    expect(fieldsOfLine('G', 'gemini --acp')).toEqual({ name: 'G', command: 'gemini', args: ['--acp'] })
    expect(fieldsOfLine('G', '"' + WIN + '" acp')).toEqual({ name: 'G', command: WIN, args: ['acp'] })
    expect(fieldsOfLine('G', '   ')).toEqual({ name: 'G', command: '', args: [] })
  })
  it('round trips a reviewer through its line', () => {
    for (const r of [rv(1), rv(2, { command: WIN, args: ['a b', 'c'] })]) {
      expect(fieldsOfLine(r.name, lineOfReviewer(r))).toEqual({ name: r.name, command: r.command, args: r.args })
    }
  })
})
