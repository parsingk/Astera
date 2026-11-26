// A language server for the Host's tests (Phase 3 Part 3): plain Node, Content-Length framing on stdio, and only what
// the tests need. FAKE_LSP_MODE picks how it behaves:
//   pull      diagnosticProvider; a pull answers one error for each line of the document holding ERROR, computed when
//             asked and sent after FAKE_LSP_PULL_DELAY_MS
//   push      no diagnosticProvider; publishDiagnostics after each didOpen, with the version
//   silent    never answers initialize
//   flood     pushes 1000 diagnostics after didOpen, and writes 5000 log lines to stderr and as window/logMessage
//   crash     exits with code 3 200 ms after initialized
//   config    registers textDocument/diagnostic dynamically (as pyright does), asks workspace/configuration for the
//             sections python and pyright, then asks for a refresh; a pull answers one problem whose message is the
//             python section's pythonPath
//   uri-lower push, naming the document file:///<drive lower-case>%3A/... (TypeScript 7's spelling)
//   codes     pull answers a reportMissingImports and a reportAssignmentType problem
//   watch     pull; registers workspace/didChangeWatchedFiles when the client offers it, and answers each change with a
//             push naming it on the first open document
//   pull-silent      never answers a pull
//   pull-first-silent never answers the first pull, answers the rest
//   push-stray push for the open document, a file never opened, and a tsconfig.json
//   version   a pull answers one problem whose message is v<the document's version>
//   refresh-storm pull; after initialized asks for ten refreshes at once; a pull's message is pulls=<count so far>
//   stderr-noline writes 200 KB to stderr with no line end after initialized
// `shutdown` with "params": null is refused (TypeScript 7 does); `exit` ends the process with FAKE_LSP_EXIT_CODE (0).
const mode = process.env.FAKE_LSP_MODE ?? 'pull'
const pullDelay = Number(process.env.FAKE_LSP_PULL_DELAY_MS ?? 0)
const docs = new Map()
let nextId = 1
const waiting = new Map()
let config = null
let watchOffered = false
let pulls = 0
let rootUri = ''

const send = (m) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const errorsOf = (text) =>
  text.split('\n').flatMap((line, i) =>
    line.includes('ERROR') ? [{ range: { start: { line: i, character: line.indexOf('ERROR') }, end: { line: i, character: line.indexOf('ERROR') + 5 } }, severity: 1, message: `error on line ${i + 1}`, code: 9999 }] : []
  )
const lowerDrive = (uri) => uri.replace(/^file:\/\/\/([A-Za-z]):/, (_, d) => `file:///${d.toLowerCase()}%3A`)
const publish = (uri, version, diagnostics) =>
  send({ method: 'textDocument/publishDiagnostics', params: { uri: mode === 'uri-lower' ? lowerDrive(uri) : uri, version, diagnostics } })

const handle = async (m) => {
  if (m.id !== undefined && m.method === undefined) {
    const resolve = waiting.get(m.id)
    waiting.delete(m.id)
    resolve?.(m.result)
    return
  }
  switch (m.method) {
    case 'initialize':
      if (mode === 'silent') return
      watchOffered = m.params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
      rootUri = m.params?.rootUri ?? ''
      send({
        id: m.id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 2 },
            ...(['pull', 'codes', 'watch', 'pull-silent', 'pull-first-silent', 'version', 'refresh-storm'].includes(mode) ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {})
          },
          serverInfo: { name: 'fake-lsp' }
        }
      })
      return
    case 'initialized':
      if (mode === 'crash') setTimeout(() => process.exit(3), 200)
      if (mode === 'watch' && watchOffered) await ask('client/registerCapability', { registrations: [{ id: 'w1', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.py' }] } }] })
      if (mode === 'refresh-storm') for (let i = 0; i < 10; i++) void ask('workspace/diagnostic/refresh', null)
      if (mode === 'stderr-noline') process.stderr.write('x'.repeat(200 * 1024))
      if (mode === 'config') {
        await ask('client/registerCapability', { registrations: [{ id: 'd1', method: 'textDocument/diagnostic', registerOptions: {} }] })
        config = await ask('workspace/configuration', { items: [{ section: 'python', scopeUri: 'file:///root' }, { section: 'pyright' }] })
        await ask('workspace/diagnostic/refresh', null)
      }
      return
    case 'textDocument/didOpen': {
      const d = m.params.textDocument
      docs.set(d.uri, d)
      if (mode === 'push' || mode === 'uri-lower') publish(d.uri, d.version, errorsOf(d.text))
      if (mode === 'push-stray') {
        publish(d.uri, d.version, errorsOf(d.text))
        const base = d.uri.slice(0, d.uri.lastIndexOf('/'))
        publish(`${base}/other.ts`, undefined, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'stray' }])
        publish(`${base}/tsconfig.json`, undefined, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'config', code: 5102 }])
      }
      if (mode === 'flood') {
        for (let i = 0; i < 5000; i++) {
          process.stderr.write(`flood line ${i}\n`)
          send({ method: 'window/logMessage', params: { type: 3, message: `log ${i}` } })
        }
        publish(d.uri, d.version, Array.from({ length: 1000 }, (_, i) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } }, severity: 2, message: `w${i}` })))
      }
      return
    }
    case 'textDocument/didClose':
      docs.delete(m.params.textDocument.uri)
      return
    case 'workspace/didChangeWatchedFiles': {
      const first = [...docs.values()][0]
      if (first) publish(first.uri, first.version, m.params.changes.map((c) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `changed ${c.uri} ${c.type}` })))
      return
    }
    case 'textDocument/diagnostic': {
      const d = docs.get(m.params.textDocument.uri)
      pulls++
      if (mode === 'pull-silent' || (mode === 'pull-first-silent' && pulls === 1)) return
      const one = (message, code) => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message, ...(code ? { code } : {}) }]
      if (mode === 'codes') return send({ id: m.id, result: { kind: 'full', items: [...one('missing', 'reportMissingImports'), ...one('assign', 'reportAssignmentType')] } })
      if (mode === 'version') return send({ id: m.id, result: { kind: 'full', items: one(`v${d?.version}`) } })
      if (mode === 'refresh-storm') return send({ id: m.id, result: { kind: 'full', items: one(`pulls=${pulls}`) } })
      const items =
        mode === 'config'
          ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: String(config?.[0]?.pythonPath) + '|' + JSON.stringify(config?.[0]?.analysis ?? null) + '|' + JSON.stringify(config?.[1] ?? null) }]
          : errorsOf(d?.text ?? '')
      setTimeout(() => send({ id: m.id, result: { kind: 'full', items } }), pullDelay)
      return
    }
    case 'shutdown':
      if ('params' in m && m.params === null) send({ id: m.id, error: { code: -32602, message: 'InvalidParams: expected no params, got null' } })
      else send({ id: m.id, result: null })
      return
    case 'exit':
      process.exit(Number(process.env.FAKE_LSP_EXIT_CODE ?? 0))
  }
}

let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  for (;;) {
    const end = pending.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString('ascii'))?.[1])
    if (pending.length < end + 4 + length) return
    const body = pending.subarray(end + 4, end + 4 + length).toString('utf8')
    pending = pending.subarray(end + 4 + length)
    void handle(JSON.parse(body))
  }
})
process.stdin.on('end', () => process.exit(0))
