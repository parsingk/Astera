import { describe, it, expect } from 'vitest'
import { defaultSessionTitle, normalizeSessionTitle } from './title'

describe('defaultSessionTitle', () => {
  it('is the project folder name', () => {
    expect(defaultSessionTitle('D:/work/astera')).toBe('astera')
    expect(defaultSessionTitle('/work/astera')).toBe('astera')
  })

  // A root has no basename. Falling through to the path itself keeps the tab from going blank, which
  // is the same choice spawn has always made.
  it('falls back to the path when there is no basename', () => {
    expect(defaultSessionTitle('/')).toBe('/')
    expect(defaultSessionTitle('')).toBe('')
  })

  // Both of these are win32 notation, and the module reads a cwd with the platform's own `path`: on
  // POSIX `\` is an ordinary character, so `D:\work\astera` is one long filename, and `D:/` has the
  // basename `D:` rather than none. A cwd only ever arrives in the notation of the machine it came
  // from, so this is asserted where it can hold rather than made platform-independent.
  it.runIf(process.platform === 'win32')('reads a backslash path and a drive root', () => {
    expect(defaultSessionTitle('D:\\work\\astera')).toBe('astera')
    expect(defaultSessionTitle('D:/')).toBe('D:/')
  })
})

describe('normalizeSessionTitle', () => {
  const cwd = 'D:/work/astera'

  it('keeps what the person typed', () => {
    expect(normalizeSessionTitle('결제 리팩터링', cwd)).toBe('결제 리팩터링')
  })

  it('trims the edges', () => {
    expect(normalizeSessionTitle('  결제  ', cwd)).toBe('결제')
  })

  // The title is not only a tab label: it goes into Slack's one-line message prefix
  // (`[title · account] …`) and into an OS notification's title. A newline would break the first and
  // is silently dropped by the second, so the shape is settled here rather than at each reader.
  it('collapses inner whitespace into single spaces', () => {
    expect(normalizeSessionTitle('결제\n리팩터링', cwd)).toBe('결제 리팩터링')
    expect(normalizeSessionTitle('결제\t\t리팩터링', cwd)).toBe('결제 리팩터링')
    expect(normalizeSessionTitle('a   b', cwd)).toBe('a b')
  })

  // Clearing the box is how a person asks for the default back — there is no other affordance for
  // it, and an empty tab would be worse than any name.
  it('an empty or whitespace-only name returns to the project folder name', () => {
    expect(normalizeSessionTitle('', cwd)).toBe('astera')
    expect(normalizeSessionTitle('   ', cwd)).toBe('astera')
    expect(normalizeSessionTitle('\n\t', cwd)).toBe('astera')
  })

  // A pasted paragraph is the realistic way this gets long, and the value travels into a shared
  // Slack channel. The cap is generous enough that nobody types into it by accident.
  it('caps a very long name', () => {
    const long = 'x'.repeat(500)
    const out = normalizeSessionTitle(long, cwd)
    expect(out.length).toBe(120)
    expect(out).toBe('x'.repeat(120))
  })

  it('caps after trimming, not before', () => {
    expect(normalizeSessionTitle(`   ${'y'.repeat(130)}   `, cwd).length).toBe(120)
  })
})
