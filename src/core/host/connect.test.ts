import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { connectHost } from './connect'
import { encodeLine } from '../../host/framing'
import { HOST_PROTOCOL } from './protocol'

const servers: net.Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers.length = 0
})

/** A server that answers hello the way the Host does. Unix socket even on win32 tests is not
 *  possible, so this uses a temp path on posix and a pipe name on win32. */
const listen = async (onHello: (sock: net.Socket) => void): Promise<string> => {
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\astera-test-${Math.random().toString(16).slice(2)}`
      : path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'astera-')), 'sock')
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    sock.once('data', () => onHello(sock))
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(address, r))
  return address
}

describe('connectHost', () => {
  it('핸드셰이크가 끝나면 hello 를 돌려준다', async () => {
    const address = await listen((sock) => {
      sock.write(
        encodeLine({
          t: 'hello',
          protocol: HOST_PROTOCOL,
          host: '1.3.25',
          pid: 7,
          startedAt: 'T',
          features: ['orch']
        })
      )
    })
    const conn = await connectHost({ address, app: 'test', timeoutMs: 2000 })
    expect('error' in conn).toBe(false)
    if ('error' in conn) return
    expect(conn.hello.features).toEqual(['orch'])
    conn.close()
  })

  // 아무도 없는 주소는 기다리는 것이 아니라 바로 답이 나와야 한다
  it('아무도 없으면 unreachable 이다', async () => {
    const address =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\astera-test-nobody'
        : path.join(os.tmpdir(), 'astera-nobody', 'sock')
    const r = await connectHost({ address, app: 'test', timeoutMs: 500 })
    expect(r).toEqual({ error: 'unreachable' })
  })

  it('프로토콜이 다르면 protocol 이다', async () => {
    const address = await listen((sock) => {
      sock.write(encodeLine({ t: 'protocol-mismatch', protocol: 99 }))
    })
    const r = await connectHost({ address, app: 'test', timeoutMs: 2000 })
    expect(r).toEqual({ error: 'protocol' })
  })
})
