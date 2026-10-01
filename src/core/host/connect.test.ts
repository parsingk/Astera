import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { connectHost } from './connect'
import { encodeLine } from '../../host/framing'
import { HOST_PROTOCOL } from './protocol'
import { ensureHostKey, hostProof } from './hostKey'

const servers: net.Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers.length = 0
})

/** The profile every test's Host belongs to, with its key made the way the Host makes it. */
let PROFILE: string
let KEY: string
beforeAll(async () => {
  PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-connect-profile-'))
  KEY = await ensureHostKey(PROFILE)
})
afterAll(async () => {
  await fs.rm(PROFILE, { recursive: true, force: true })
})

/** A server that answers hello the way the Host does. Unix socket even on win32 tests is not
 *  possible, so this uses a temp path on posix and a pipe name on win32. `onHello` is handed the
 *  client's nonce, which a real Host answers with `proof`. */
const listen = async (onHello: (sock: net.Socket, nonce: string, hello: { role?: string }) => void): Promise<string> => {
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\astera-test-${Math.random().toString(16).slice(2)}`
      : path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'astera-')), 'sock')
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    sock.once('data', (d: string) => {
      const sent = JSON.parse(d.split('\n')[0]) as { nonce?: string; role?: string }
      onHello(sock, sent.nonce ?? '', sent)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(address, r))
  return address
}

/** The Host's hello, proven with this profile's key. */
const hello = (nonce: string, extra: Record<string, unknown> = {}): string =>
  encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, host: '1.3.25', pid: 7, startedAt: 'T', features: [], proof: hostProof(KEY, nonce), ...extra })

describe('connectHost', () => {
  it('핸드셰이크가 끝나면 hello 를 돌려준다', async () => {
    const address = await listen((sock, nonce) => sock.write(hello(nonce, { features: ['orch'] })))
    const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: () => {} })
    expect('error' in conn).toBe(false)
    if ('error' in conn) return
    expect(conn.hello.features).toEqual(['orch'])
    conn.close()
  })

  // 프로토콜 4 (core/host/hostKey.ts): 주소를 먼저 잡은 다른 계정의 프로세스는 이 프로필의 키를 모른다.
  // 증명이 없거나 틀리면 그쪽에 아무것도 보내지 않고, "Host 가 없다" 와도 다르게 끝낸다.
  it('증명이 없거나 틀린 hello 는 impostor 로 끝내고, 그 뒤로 아무것도 보내지 않는다', async () => {
    for (const proof of [undefined, hostProof('d'.repeat(64), 'x')]) {
      let after = ''
      const address = await listen((sock, nonce) => {
        sock.on('data', (d: string) => (after += d))
        sock.write(hello(nonce, { proof: proof ?? undefined }))
      })
      const logs: string[] = []
      const r = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: (m) => logs.push(m) })
      expect(r).toEqual({ error: 'impostor' })
      expect(logs.some((l) => l.includes('could not prove'))).toBe(true)
      await new Promise((res) => setTimeout(res, 50))
      expect(after).toBe('')
    }
  })

  it('이 프로필에 키가 없으면 누가 답하든 믿지 않는다', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-connect-nokey-'))
    const address = await listen((sock, nonce) => sock.write(hello(nonce)))
    const r = await connectHost({ address, profileDir: empty, app: 'test', timeoutMs: 2000, log: () => {} })
    expect(r).toEqual({ error: 'impostor' })
    await fs.rm(empty, { recursive: true, force: true })
  })

  it('announces the role it was given, and cli when it was given none', async () => {
    const seen: (string | undefined)[] = []
    const address = await listen((sock, nonce, h) => {
      seen.push(h.role)
      sock.write(hello(nonce))
    })
    for (const role of [undefined, 'mcp'] as const) {
      const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: () => {}, ...(role ? { role } : {}) })
      if ('error' in conn) throw new Error(conn.error)
      conn.close()
    }
    expect(seen).toEqual(['cli', 'mcp'])
  })

  it('hello 에 nonce 를 싣는다', async () => {
    let seen = ''
    const address = await listen((sock, nonce) => {
      seen = nonce
      sock.write(hello(nonce))
    })
    const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: () => {} })
    if ('error' in conn) throw new Error(conn.error)
    expect(seen).toMatch(/^[0-9a-f]{32}$/)
    conn.close()
  })

  // 남은 한계 Task 5: 옛 앱(1.3.25 이하)이 붙어 있다는 Host 의 말이 `astera host status` 까지 간다.
  it('hello 의 legacyApp 을 넘기고, 없으면 싣지 않는다', async () => {
    for (const [extra, want] of [[{ legacyApp: true }, true], [{}, undefined]] as const) {
      const address = await listen((sock, nonce) => sock.write(hello(nonce, { host: '1.3.26', ...extra })))
      const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: () => {} })
      if ('error' in conn) throw new Error(conn.error)
      expect(conn.hello.legacyApp).toBe(want)
      conn.close()
    }
  })

  // 아무도 없는 주소는 기다리는 것이 아니라 바로 답이 나와야 한다
  // 보안 검토 2026-09-28: 다른 사용자가 먼저 만들 수 있는 폴더의 소켓은 이 사용자의 Host 가 아니다 —
  // 누가 답하든 붙지 않고, 없는 것으로 읽는다.
  it.skipIf(process.platform === 'win32')('누구나 들어올 수 있는 폴더의 소켓에는 붙지 않는다', async () => {
    const address = await listen((sock, nonce) => sock.write(hello(nonce)))
    await fs.chmod(path.dirname(address), 0o777)
    const logs: string[] = []
    const r = await connectHost({ address, profileDir: PROFILE, app: '1.0.0', log: (m) => logs.push(m) })
    expect(r).toEqual({ error: 'unreachable' })
    expect(logs.some((l) => l.includes('not a directory only this user can open'))).toBe(true)
  })

  it('아무도 없으면 unreachable 이다', async () => {
    const address =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\astera-test-nobody'
        : path.join(os.tmpdir(), 'astera-nobody', 'sock')
    const r = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 500, log: () => {} })
    expect(r).toEqual({ error: 'unreachable' })
  })

  it('프로토콜이 다르면 protocol 이다', async () => {
    const address = await listen((sock) => {
      sock.write(encodeLine({ t: 'protocol-mismatch', protocol: 99 }))
    })
    const r = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: () => {} })
    expect(r).toEqual({ error: 'protocol' })
  })

  // 이 둘은 main/host/client.ts 의 attach() 가 같은 자리에서 이미 지키는 규칙이다 — 깨진 줄이나
  // 던진 핸들러가 아무 신호 없이 사라지면 실제로는 "Host 가 뭔가 잘못 말했다" 인 것이 "Host 가 없다"
  // 로 읽힌다.
  it('JSON 이 아닌 줄은 로그로 남고, 핸드셰이크는 그래도 끝난다', async () => {
    const address = await listen((sock, nonce) => {
      sock.write('not json\n')
      sock.write(hello(nonce))
    })
    const logs: string[] = []
    const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: (m) => logs.push(m) })
    expect('error' in conn).toBe(false)
    if ('error' in conn) return
    expect(logs.some((l) => l.includes('the Host sent a line that is not JSON'))).toBe(true)
    conn.close()
  })

  it('onMessage 로 등록한 콜백이 던지면 로그로 남는다', async () => {
    let serverSock: net.Socket | null = null
    const address = await listen((sock, nonce) => {
      serverSock = sock
      sock.write(hello(nonce))
    })
    const logs: string[] = []
    const conn = await connectHost({ address, profileDir: PROFILE, app: 'test', timeoutMs: 2000, log: (m) => logs.push(m) })
    expect('error' in conn).toBe(false)
    if ('error' in conn) return
    conn.onMessage(() => {
      throw new Error('boom')
    })
    serverSock!.write(encodeLine({ t: 'pong', seq: 1 }))
    await new Promise((r) => setTimeout(r, 100))
    expect(logs.some((l) => l.includes('a message from the Host failed'))).toBe(true)
    conn.close()
  })
})
