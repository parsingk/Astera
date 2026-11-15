// A fake ACP agent for the client's tests: `node fakeAgent.mjs <mode> [--message <text>]`.
// One mode per behavior (see the switch in runPrompt). The final message text is `--message` when given,
// otherwise the mode's own default, so later tasks can reuse it. `--retry-message <text>` is the message of every turn after
// the first in 'no-verdict-then-verdict'; `--record <file>` appends each received prompt text to <file>, one JSON string per line.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const mode = argv[0] ?? 'approve'
const mi = argv.indexOf('--message')
const message = mi >= 0 ? argv[mi + 1] : undefined
const ri = argv.indexOf('--retry-message')
const retryMessage = ri >= 0 ? argv[ri + 1] : undefined
const ci = argv.indexOf('--record')
const recordFile = ci >= 0 ? argv[ci + 1] : undefined

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n')
// `noisy` echoes numeric ids as strings, as some real agents do.
const reply = (id, result) => send({ id: mode === 'noisy' ? String(id) : id, result })
const fail = (id, code, text) => send({ id, error: { code, message: text } })
const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } })
const chunk = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

let modeSet = false
let prompts = 0
let agentId = 100
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = agentId++
    waiting.set(String(id), resolve)
    send({ id, method, params })
  })
const permission = (kind, title) =>
  ask('session/request_permission', {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', kind, title, status: 'pending' },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' }
    ]
  })
const outcomeOf = (r) => (r.result?.outcome?.outcome === 'selected' ? r.result.outcome.optionId : 'cancelled')
const finish = (id, text) => {
  chunk(text)
  reply(id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
}

async function runPrompt(id) {
  prompts++
  switch (mode) {
    case 'approve':
      return finish(id, message ?? 'APPROVE')
    case 'reject':
      return finish(id, message ?? 'REJECT')
    case 'noisy': {
      process.stdout.write('Loaded cached credentials.\n')
      send({ method: 'auth/status_update', params: { email: 'someone@example.com' } })
      send({ method: '_auth/status_update', params: { email: 'someone@example.com' } })
      const r = await ask('fs/read_text_file', { sessionId: 's1', path: 'a.txt' })
      return finish(id, message ?? `noisy ok fs:${r.error?.code}`)
    }
    case 'auto-mode':
      if (!modeSet) process.exit(2)
      return finish(id, message ?? 'mode set')
    case 'asks-edit': {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending', title: 'Edit a.txt' })
      const r = await permission('edit', 'Edit a.txt')
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' })
      return finish(id, message ?? `outcome:${outcomeOf(r)}`)
    }
    case 'asks-read': {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'pending', title: 'Read a.txt' })
      const r = await permission('read', 'Read a.txt')
      if (outcomeOf(r) !== 'allow-once') process.exit(4)
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
      return finish(id, message ?? 'read allowed')
    }
    case 'edits-without-asking':
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending', title: 'Edit b.txt' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })
      return // never answers: the client must abort the turn
    case 'hang-prompt':
      chunk('partial')
      return
    case 'exit-mid-turn':
      process.stderr.write('agent crashed: out of memory\n')
      process.exit(3)
      return
    case 'no-verdict-then-verdict':
      return finish(id, prompts === 1 ? (message ?? 'no verdict yet') : (retryMessage ?? message ?? 'verdict given'))
    case 'no-verdict-twice':
      return finish(id, message ?? 'no verdict yet')
    default:
      return fail(id, -32603, `unknown mode ${mode}`)
  }
}

function onRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      if (mode === 'hang-initialize') return
      return reply(msg.id, {
        protocolVersion: mode === 'bad-version' ? 2 : 1,
        agentCapabilities: {},
        agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' },
        authMethods: []
      })
    case 'session/new':
      if (mode === 'auth-required') return fail(msg.id, -32000, 'Gemini API key is missing or not configured.')
      if (mode === 'auto-mode') {
        return reply(msg.id, {
          sessionId: 's1',
          modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'default', name: 'Default' }] }
        })
      }
      return reply(msg.id, { sessionId: 's1' })
    case 'session/set_mode':
      if (msg.params?.modeId === 'default') modeSet = true
      return reply(msg.id, {})
    case 'session/prompt':
      if (recordFile) appendFileSync(recordFile, JSON.stringify(msg.params?.prompt?.[0]?.text ?? '') + '\n')
      return void runPrompt(msg.id)
    default:
      return fail(msg.id, -32601, 'method not found')
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method !== undefined && msg.id !== undefined) return onRequest(msg)
  const w = waiting.get(String(msg.id))
  if (w) {
    waiting.delete(String(msg.id))
    w(msg)
  }
})
