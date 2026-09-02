import { describe, it, expect } from 'vitest'
import { fillFromCommits } from './fill'

describe('fillFromCommits', () => {
  it('one commit gives its subject and body verbatim', () => {
    expect(
      fillFromCommits('parsingk/opal', [{ subject: 'fix: stop the flash', body: 'Because X.' }])
    ).toEqual({ title: 'fix: stop the flash', body: 'Because X.' })
  })

  it('one commit with no body gives an empty body, not the subject repeated', () => {
    expect(fillFromCommits('parsingk/opal', [{ subject: 'chore: bump', body: '' }])).toEqual({
      title: 'chore: bump',
      body: ''
    })
  })

  it('several commits title from the branch and list the subjects', () => {
    const got = fillFromCommits('parsingk/opal', [
      { subject: 'feat: a', body: 'ignored' },
      { subject: 'fix: b', body: '' }
    ])
    expect(got.title).toBe('parsingk/opal')
    expect(got.body).toBe('- feat: a\n- fix: b')
  })

  // gh --fill lists newest first; the caller hands them in that order and this must not reorder.
  it('keeps the order it was given', () => {
    const got = fillFromCommits('b', [
      { subject: 'third', body: '' },
      { subject: 'second', body: '' },
      { subject: 'first', body: '' }
    ])
    expect(got.body).toBe('- third\n- second\n- first')
  })

  it('no commits gives the branch name and an empty body', () => {
    expect(fillFromCommits('parsingk/opal', [])).toEqual({ title: 'parsingk/opal', body: '' })
  })

  it('trims surrounding whitespace off a single commit body', () => {
    expect(fillFromCommits('b', [{ subject: 's', body: '\n\ntext\n\n' }]).body).toBe('text')
  })
})
