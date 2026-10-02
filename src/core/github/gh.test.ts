import { describe, it, expect } from 'vitest'
import { classifyGhFailure, ghFailureSentence, probeGh, type GhResult } from './gh'

const result = (over: Partial<GhResult>): GhResult => ({
  ok: false,
  stdout: '',
  stderr: '',
  ...over
})

describe('classifyGhFailure', () => {
  it('classifies primary and secondary rate limits', () => {
    expect(
      classifyGhFailure('HTTP 403: API rate limit exceeded for user ID 1 (https://docs.github.com/...)')
    ).toBe('rate-limit')
    expect(classifyGhFailure('You have exceeded a secondary rate limit.')).toBe('rate-limit')
  })

  it('classifies auth failures', () => {
    expect(classifyGhFailure('HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe('auth')
    expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('auth')
  })

  it('classifies missing repositories', () => {
    expect(classifyGhFailure('GraphQL: Could not resolve to a Repository with the name x/y.')).toBe('not-found')
    expect(classifyGhFailure('HTTP 404: Not Found (https://api.github.com/repos/x/y)')).toBe('not-found')
  })

  it('classifies network failures', () => {
    expect(classifyGhFailure('dial tcp: lookup api.github.com: no such host')).toBe('network')
    expect(classifyGhFailure('net/http: request canceled (Client.Timeout exceeded)')).toBe('network')
  })

  it('classifies a repo with no configured remote', () => {
    expect(classifyGhFailure('no git remotes found')).toBe('no-remote')
  })

  it('a maxBuffer overflow classifies as truncated, not other — overflow leaves stderr empty, so it can only be read off spawnError', () => {
    // Constructed without spawning anything, the way gh.ts itself would receive it: the process
    // was killed for exceeding maxBuffer, so stdout is a partial fragment and stderr never filled.
    const overflow = result({ spawnError: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '[{"number":1' })
    expect(classifyGhFailure(overflow.stderr, overflow.spawnError)).toBe('truncated')
  })

  it('everything else is other', () => {
    expect(classifyGhFailure('unknown flag: --nope')).toBe('other')
  })
})

describe('probeGh', () => {
  it('ENOENT means gh is not installed', async () => {
    const probe = await probeGh(async () => result({ spawnError: 'ENOENT' }))
    expect(probe).toEqual({ kind: 'not-installed' })
  })

  it('a successful auth status is connected, with the login parsed', async () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account parsingk (keyring)',
      '  - Active account: true'
    ].join('\n')
    const probe = await probeGh(async () => result({ ok: true, stdout: out }))
    expect(probe).toEqual({ kind: 'connected', account: 'parsingk' })
  })

  it('the older "as <login>" phrasing also parses', async () => {
    const probe = await probeGh(async () =>
      result({ ok: true, stdout: '✓ Logged in to github.com as parsingk (oauth_token)' })
    )
    expect(probe).toEqual({ kind: 'connected', account: 'parsingk' })
  })

  it('connected without a parseable login stays connected, account absent', async () => {
    const probe = await probeGh(async () => result({ ok: true, stdout: 'github.com: ok' }))
    expect(probe).toEqual({ kind: 'connected' })
  })

  it('a "not logged in" failure is not-authenticated', async () => {
    const probe = await probeGh(async () =>
      result({ stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' })
    )
    expect(probe).toEqual({ kind: 'not-authenticated' })
  })

  it('any other failure is error', async () => {
    const probe = await probeGh(async () => result({ stderr: 'boom' }))
    expect(probe).toEqual({ kind: 'error' })
  })
})

describe('ghFailureSentence', () => {
  it('ENOENT is not-installed, before any stderr is read', () => {
    expect(ghFailureSentence(result({ spawnError: 'ENOENT', stderr: 'rate limit' }))).toEqual({
      kind: 'not-installed',
      message: "GitHub CLI (gh) is not installed or not on the Astera Host's PATH"
    })
  })

  it('auth names the command to run', () => {
    expect(ghFailureSentence(result({ stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }))).toEqual({
      kind: 'auth',
      message: 'gh is not logged in: run `gh auth login`'
    })
  })

  it("every other kind is one sentence ending with gh's first stderr line", () => {
    const sentence = (stderr: string, spawnError?: string) => ghFailureSentence(result({ stderr, spawnError }))
    expect(sentence('HTTP 403: API rate limit exceeded\nsee docs')).toEqual({
      kind: 'rate-limit',
      message: 'GitHub rate limit reached: HTTP 403: API rate limit exceeded'
    })
    expect(sentence('gh: Not Found (HTTP 404)')).toEqual({
      kind: 'not-found',
      message: 'GitHub found no such repository, pull request, issue or run: gh: Not Found (HTTP 404)'
    })
    expect(sentence('no git remotes found')).toEqual({
      kind: 'no-remote',
      message: "This folder's git repository has no remote for gh to use"
    })
    expect(sentence('dial tcp: lookup api.github.com: no such host')).toEqual({
      kind: 'network',
      message: 'Could not reach GitHub: dial tcp: lookup api.github.com: no such host'
    })
    expect(sentence('', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')).toEqual({
      kind: 'truncated',
      message: "gh's answer was too large and was cut off"
    })
    expect(sentence('\r\nunknown flag: --nope\r\nUsage: ...')).toEqual({
      kind: 'other',
      message: 'gh failed: unknown flag: --nope'
    })
    expect(sentence('')).toEqual({ kind: 'other', message: 'gh failed' })
  })
})
