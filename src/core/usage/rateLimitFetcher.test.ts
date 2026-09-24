import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RateLimitFetcher, type FetchLike } from './rateLimitFetcher'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-usage-'))
  await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(dir, { recursive: true, force: true })
})

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): ReturnType<FetchLike> =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body })

describe('RateLimitFetcher with an injected fetch (S6 R11)', () => {
  it('asks through the fetch it was given, with the account token, and maps the answer', async () => {
    const calls: { url: string; auth: string }[] = []
    const f: FetchLike = (url, init) => {
      calls.push({ url, auth: init.headers.Authorization })
      return reply(200, { five_hour: { utilization: 40, resets_at: '2026-09-25T12:00:00Z' } })
    }
    const global = vi.fn()
    vi.stubGlobal('fetch', global)
    const u = await new RateLimitFetcher(() => 0, 'linux', dir, 'u', async () => null, f).get(dir)
    expect(calls).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'Bearer tok' }])
    expect(global).not.toHaveBeenCalled()
    expect(u.status).toBe('ok')
    expect(u.session?.usedPercent).toBe(40)
  })
  it('answers error on a 429 and on a throw, never rejecting (the gate then accepts, Q4)', async () => {
    const r429 = await new RateLimitFetcher(() => 0, 'linux', dir, 'u', async () => null, () => reply(429, {}, { 'retry-after': '30' })).get(dir)
    expect(r429.status).toBe('error')
    const thrown = await new RateLimitFetcher(() => 0, 'linux', dir, 'u', async () => null, () => Promise.reject(new Error('ECONNREFUSED'))).get(dir)
    expect(thrown.status).toBe('error')
  })
  it('uses the global fetch when none is given', async () => {
    const global = vi.fn(() => reply(200, { five_hour: { utilization: 1 } }))
    vi.stubGlobal('fetch', global)
    await new RateLimitFetcher(() => 0, 'linux', dir, 'u', async () => null).get(dir)
    expect(global).toHaveBeenCalledTimes(1)
  })
})
