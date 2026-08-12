import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  errorOutput,
  exitCodeFor,
  ensureTrailingNewline,
  applyStdin,
  clientTimeoutMs,
  buildRequest,
  resolveGuidePath,
  readGuide,
  readInfo
} from './run'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'

describe('errorOutput', () => {
  it('메시지를 {error} JSON 한 줄로 감싼다', () => {
    expect(JSON.parse(errorOutput('boom'))).toEqual({ error: 'boom' })
  })
})

describe('exitCodeFor', () => {
  it('2xx는 0이다', () => {
    expect(exitCodeFor(200)).toBe(0)
    expect(exitCodeFor(299)).toBe(0)
  })
  it('2xx가 아니면 1이다', () => {
    expect(exitCodeFor(400)).toBe(1)
    expect(exitCodeFor(500)).toBe(1)
    expect(exitCodeFor(199)).toBe(1)
  })
  it('ask의 타임아웃 응답은 200이므로 0이다 (타임아웃은 오류가 아니라 정보)', () => {
    // 서버는 ask --wait 타임아웃을 {answered:false, timedOut:true} 본문 + 200으로 응답한다.
    expect(exitCodeFor(200)).toBe(0)
  })
})

describe('ensureTrailingNewline', () => {
  it('줄바꿈이 없으면 붙인다', () => {
    expect(ensureTrailingNewline('abc')).toBe('abc\n')
  })
  it('이미 있으면 그대로 둔다', () => {
    expect(ensureTrailingNewline('abc\n')).toBe('abc\n')
  })
})

describe('applyStdin', () => {
  it('wantsStdin에 있는 키만 stdin 텍스트로 채운다', () => {
    const r = applyStdin({ args: { a: 1 }, keys: ['spec'], text: '본문' })
    expect(r).toEqual({ a: 1, spec: '본문' })
  })
  it('여러 키를 같은 텍스트로 채운다', () => {
    const r = applyStdin({ args: {}, keys: ['question', 'body'], text: 'q' })
    expect(r).toEqual({ question: 'q', body: 'q' })
  })
  it('원본 args 객체를 변형하지 않는다', () => {
    const args = { a: 1 }
    applyStdin({ args, keys: ['spec'], text: '본문' })
    expect(args).toEqual({ a: 1 })
  })
})

describe('clientTimeoutMs', () => {
  // 서버(server.ts)와 같은 상수(core/orchestration/types.ts)를 가져와 대조한다 — 숫자를 여기
  // 하드코딩하면 한쪽만 바뀌었을 때 어긋남을 다시 놓친다(리뷰 발견: ask 기본값이 서버보다
  // 짧아 서버가 응답하기 전에 클라이언트가 먼저 끊었다).
  it('ask 기본값(--timeout-ms 없음)은 서버의 ask 기본 시한보다 크다 — 클라이언트가 서버보다 먼저 끊으면 안 된다', () => {
    expect(clientTimeoutMs({ cmd: 'ask', args: {} })).toBeGreaterThan(DEFAULT_ASK_TIMEOUT_MS)
  })
  it('check 기본값(--timeout-ms 없음)은 서버의 check 기본 시한보다 크다', () => {
    expect(clientTimeoutMs({ cmd: 'check', args: {} })).toBeGreaterThan(DEFAULT_CHECK_TIMEOUT_MS)
  })
  it('--timeout-ms를 명시하면 그 값 위에 고정된 여유를 더해 그대로 쓴다 (명령·기본값과 무관)', () => {
    const headroom = clientTimeoutMs({ cmd: 'ask', args: { timeoutMs: 1000 } }) - 1000
    expect(clientTimeoutMs({ cmd: 'ask', args: { timeoutMs: 5000 } })).toBe(5000 + headroom)
    expect(clientTimeoutMs({ cmd: 'check', args: { timeoutMs: 5000 } })).toBe(5000 + headroom)
  })
})

describe('buildRequest', () => {
  it('POST /에 Authorization·X-Astera-Session 헤더와 {cmd, args} 본문을 담는다', () => {
    const { url, init } = buildRequest({
      port: 5173,
      token: 'tok',
      sessionId: 'sess_1',
      cmd: 'ask',
      args: { question: 'q' },
      cwd: 'D:/irrelevant'
    })
    expect(url).toBe('http://127.0.0.1:5173/')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer tok')
    expect(init.headers['x-astera-session']).toBe('sess_1')
    expect(JSON.parse(init.body)).toEqual({ cmd: 'ask', args: { question: 'q' } })
  })
  it('세션 id가 없어도(오케스트레이터 프리앰블 미주입) 빈 문자열로 보낸다', () => {
    const { init } = buildRequest({
      port: 1,
      token: 't',
      sessionId: '',
      cmd: 'help',
      args: {},
      cwd: 'D:/irrelevant'
    })
    expect(init.headers['x-astera-session']).toBe('')
  })
})

describe('buildRequest — run-create의 --cwd 기본값 (task-13a)', () => {
  // server.ts의 run-create는 --cwd 생략 시 process.cwd()로 메꾸지만 그건 Electron 메인
  // 프로세스의 cwd라 CLI 프로세스와 무관하다 — CLI가 자기 cwd를 채워 보내야 한다.
  it('--cwd 없이 run-create를 보내면 CLI의 cwd를 args에 채운다', () => {
    const { init } = buildRequest({
      port: 1,
      token: 't',
      sessionId: 's',
      cmd: 'run-create',
      args: { objective: 'o' },
      cwd: 'D:/my-cwd'
    })
    expect(JSON.parse(init.body)).toEqual({
      cmd: 'run-create',
      args: { objective: 'o', cwd: 'D:/my-cwd' }
    })
  })
  it('--cwd가 명시되면 CLI의 cwd보다 그것이 이긴다', () => {
    const { init } = buildRequest({
      port: 1,
      token: 't',
      sessionId: 's',
      cmd: 'run-create',
      args: { objective: 'o', cwd: 'D:/explicit' },
      cwd: 'D:/my-cwd'
    })
    expect(JSON.parse(init.body)).toEqual({
      cmd: 'run-create',
      args: { objective: 'o', cwd: 'D:/explicit' }
    })
  })
  it('run-create가 아닌 명령에는 CLI의 cwd를 채우지 않는다', () => {
    const { init } = buildRequest({
      port: 1,
      token: 't',
      sessionId: 's',
      cmd: 'task-list',
      args: {},
      cwd: 'D:/my-cwd'
    })
    expect(JSON.parse(init.body)).toEqual({ cmd: 'task-list', args: {} })
  })
})

describe('resolveGuidePath', () => {
  it('ASTERA_SKILLS 환경변수가 가리키는 디렉터리 아래 orchestration-guide.md를 가리킨다', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: '/opt/skills' } })
    expect(r).toEqual({ ok: true, path: path.join('/opt/skills', 'orchestration-guide.md') })
  })
  it('--skills-dir 인자가 있으면 환경변수보다 우선한다', () => {
    const r = resolveGuidePath({
      args: { skillsDir: '/custom' },
      env: { ASTERA_SKILLS: '/opt/skills' }
    })
    expect(r).toEqual({ ok: true, path: path.join('/custom', 'orchestration-guide.md') })
  })
  it('둘 다 없으면 ASTERA_SKILLS를 언급하는 명확한 에러를 낸다', () => {
    const r = resolveGuidePath({ args: {}, env: {} })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('ASTERA_SKILLS')
  })
})

describe('readGuide', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-guide-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('파일 내용을 그대로 읽는다', async () => {
    const p = path.join(dir, 'orchestration-guide.md')
    await fs.writeFile(p, '# guide', 'utf8')
    expect(readGuide(p)).toEqual({ ok: true, content: '# guide' })
  })
  it('파일이 없으면 경로를 담은 명확한 에러를 낸다', () => {
    const missing = path.join(dir, 'missing.md')
    const r = readGuide(missing)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain(missing)
  })
})

describe('readInfo', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-info-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('port·token JSON을 읽는다', async () => {
    const p = path.join(dir, 'orch-info.json')
    await fs.writeFile(p, JSON.stringify({ port: 1234, token: 'abc' }), 'utf8')
    expect(readInfo(p)).toEqual({ ok: true, info: { port: 1234, token: 'abc' } })
  })
  it('파일이 없으면 명확한 에러를 낸다', () => {
    expect(readInfo(path.join(dir, 'missing.json')).ok).toBe(false)
  })
  it('JSON이 깨졌으면 명확한 에러를 낸다', async () => {
    const broken = path.join(dir, 'broken.json')
    await fs.writeFile(broken, '{not json', 'utf8')
    expect(readInfo(broken).ok).toBe(false)
  })
})
