// The measurement's client for `codex app-server`, against a stand-in server: a node process speaking the same
// line-per-message JSON-RPC, so the client is checked before a run depends on it.
import { describe, it, expect } from 'vitest'
import { startAppServer } from './appServer.mjs'

// Answers by method; asks the client a question of its own and sends a notification before answering `initialize`,
// as codex does, and reports back what the client sent it.
const FAKE = `
const seen = []
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    seen.push(m)
    if (m.method === 'initialize') {
      out({ method: 'note', params: {} })
      out({ id: 'srv-1', method: 'ask', params: {} })
      out({ id: m.id, result: { client: m.params.clientInfo.name } })
    } else if (m.method === 'fail') out({ id: m.id, error: { code: -32600, message: 'no' } })
    else if (m.method === 'seen') out({ id: m.id, result: seen })
    else if (m.method === 'exit') process.exit(3)
  }
})
`
const fake = () => startAppServer({ file: process.execPath, args: ['-e', FAKE], cwd: process.cwd(), env: process.env })

describe('startAppServer', () => {
  it('answers each request by its id, an error as an error', async () => {
    const s = fake()
    try {
      expect(await s.request('initialize', { clientInfo: { name: 'astera' } })).toEqual({ result: { client: 'astera' } })
      expect(await s.request('fail', {})).toEqual({ error: { code: -32600, message: 'no' } })
    } finally {
      await s.stop()
    }
  })

  // A request from the server that nobody answers would leave it waiting
  it('sends notifications and answers the server’s own requests with an error', async () => {
    const s = fake()
    try {
      await s.request('initialize', { clientInfo: { name: 'astera' } })
      s.notify('initialized', {})
      const { result } = await s.request('seen', {})
      expect(result.find((m) => m.method === 'initialized')).toEqual({ method: 'initialized', params: {} })
      expect(result.find((m) => m.id === 'srv-1')).toMatchObject({ id: 'srv-1', error: { code: -32601 } })
      expect(s.notifications()).toContain('note')
    } finally {
      await s.stop()
    }
  })

  it('ends a request nobody answers at its timeout', async () => {
    const s = fake()
    try {
      const started = Date.now()
      expect(await s.request('silent', {}, 300)).toMatchObject({ timedOut: true, error: { message: expect.stringContaining('silent') } })
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await s.stop()
    }
  })

  it('answers every open request when the server exits, and says how it ended', async () => {
    const s = fake()
    const open = s.request('silent', {}, 10_000)
    const exit = s.request('exit', {}, 10_000)
    expect(await open).toMatchObject({ exited: true, error: { message: expect.stringContaining('exited') } })
    expect(await exit).toMatchObject({ exited: true })
    expect(await s.stop()).toEqual({ code: 3, signal: null })
    expect(await s.request('late', {})).toMatchObject({ exited: true })
  })

  it('records a program that is not there', async () => {
    const s = startAppServer({ file: 'astera-no-such-program', args: [], cwd: process.cwd(), env: process.env })
    expect(await s.request('initialize', {}, 5000)).toMatchObject({ exited: true })
    expect(s.spawnError()).toMatch(/ENOENT/)
    await s.stop()
  })
})
