// A stdio MCP server for the Gateway's tests. argv: <pidFile> [silent|slow|stubborn]. It appends its pid to pidFile when
// it starts; `silent` never answers `initialize`, `slow` answers it after 800 ms, `stubborn` keeps running when its stdin
// ends. Tools: echo, env (says whether a variable is set, never its value), crash,
// hang, roots (asks the client for its roots). One resource and one prompt.
const fs = require('fs')
const [pidFile, mode] = process.argv.slice(2)
fs.appendFileSync(pidFile, `${process.pid}\n`)
if (mode === 'stubborn') {
  process.stdin.on('end', () => {})
  setInterval(() => {}, 1000)
}
let buf = ''
let nextId = 1
const waiting = new Map()
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const text = (t) => ({ content: [{ type: 'text', text: t }] })
process.stdin.on('data', (c) => {
  buf += c.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.id !== undefined && m.method === undefined) {
      waiting.get(m.id)?.(m.result)
      waiting.delete(m.id)
      continue
    }
    if (m.method === 'notifications/cancelled') {
      fs.appendFileSync(`${pidFile}.events`, `cancelled ${m.params.requestId}\n`)
      continue
    }
    if (m.method === 'initialize') {
      if (mode === 'silent') continue
      if (mode === 'slow') {
        const id = m.id
        const version = m.params.protocolVersion
        setTimeout(() => reply(id, { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } }), 800)
        continue
      }
      reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' }, instructions: 'fixture' })
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: ['echo', 'env', 'crash', 'hang', 'roots', 'changed', 'split'].map((name) => ({ name, inputSchema: { type: 'object', properties: { text: { type: 'string' }, name: { type: 'string' } } } })) })
    } else if (m.method === 'tools/call') {
      const { name, arguments: args = {} } = m.params
      if (name === 'echo') reply(m.id, text(`echo: ${args.text ?? ''}`))
      else if (name === 'env') reply(m.id, text(process.env[args.name] === undefined ? 'unset' : 'set'))
      else if (name === 'crash') process.exit(3)
      else if (name === 'hang') {
        /* never answers */
      } else if (name === 'roots') {
        const id = nextId++
        waiting.set(id, (r) => reply(m.id, text(JSON.stringify(r.roots))))
        send({ jsonrpc: '2.0', id, method: 'roots/list' })
      } else if (name === 'split') {
        process.stderr.write('abc')
        setTimeout(() => {
          process.stderr.write('def\n')
          reply(m.id, text('split'))
        }, 50)
      } else if (name === 'changed') {
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        reply(m.id, text('sent'))
      }
    } else if (m.method === 'resources/list') reply(m.id, { resources: [{ uri: 'fixture://one', name: 'one' }] })
    else if (m.method === 'prompts/list') reply(m.id, { prompts: [{ name: 'hello' }] })
    else if (m.id !== undefined) reply(m.id, {})
  }
})
