import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { exitCodeFor } from '../core/orchestration/cliOutput'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  errorOutput,
  exitCodeForStatus,
  ensureTrailingNewline,
  applyStdin,
  clientTimeoutMs,
  buildRequest,
  resolveGuidePath,
  readGuide,
  readInfo,
  outputMode,
  renderErr,
  renderOk,
  writePendingReport
} from './run'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'
import {
  parsePendingReport,
  pendingReportFileName,
  pendingReportTempName,
  pendingReportsDirFrom
} from '../core/orchestration/pendingReports'

describe('errorOutput', () => {
  // 스크립트가 기대는 것은 봉투다(설계 §7) — 코드는 기계의 것이고 문구는 사람의 것이다.
  it('오류를 봉투 한 줄로 감싼다', () => {
    expect(JSON.parse(errorOutput('boom'))).toEqual({
      ok: false,
      error: { code: 'FAILED', message: 'boom', details: {} }
    })
  })
  it('코드를 주면 그것이 실린다', () => {
    expect(JSON.parse(errorOutput('nope', 'NOT_FOUND')).error.code).toBe('NOT_FOUND')
  })
})

describe('exitCodeForStatus', () => {
  it('2xx는 0이다', () => {
    expect(exitCodeForStatus(200)).toBe(0)
    expect(exitCodeForStatus(299)).toBe(0)
  })
  // 스크립트가 분기할 수 있어야 한다 — 인자를 잘못 준 것과 그런 id 가 없는 것은 다른 일이다
  it('상태마다 다른 종료 코드를 준다 (설계 §8)', () => {
    expect(exitCodeForStatus(400)).toBe(2)
    expect(exitCodeForStatus(403)).toBe(5)
    expect(exitCodeForStatus(404)).toBe(4)
    expect(exitCodeForStatus(409)).toBe(6)
  })
  // 모르는 상태를 그럴듯한 코드로 넘겨짚지 않는다 — 짐작이 스크립트의 분기를 조용히 틀리게 한다
  it('모르는 상태는 일반 실패다', () => {
    expect(exitCodeForStatus(500)).toBe(1)
    expect(exitCodeForStatus(199)).toBe(1)
  })
  it('ask의 타임아웃 응답은 200이므로 0이다 (타임아웃은 오류가 아니라 정보)', () => {
    // 서버는 ask --wait 타임아웃을 {answered:false, timedOut:true} 본문 + 200으로 응답한다.
    expect(exitCodeForStatus(200)).toBe(0)
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

describe('browser commands', () => {
  it('resolveGuidePath picks the browser guide when asked', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: 'D:/skills' }, guide: 'browser' })
    expect(r).toEqual({ ok: true, path: path.join('D:/skills', 'browser-guide.md') })
  })
  it('resolveGuidePath still defaults to the orchestration guide', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: 'D:/skills' } })
    expect(r).toEqual({ ok: true, path: path.join('D:/skills', 'orchestration-guide.md') })
  })
  it('browser-js waits for the whole script plus headroom', () => {
    expect(clientTimeoutMs({ cmd: 'browser-js', args: {} })).toBe(60_000 + 30_000)
  })
  it('an explicit --timeout-ms still wins for browser-js', () => {
    expect(clientTimeoutMs({ cmd: 'browser-js', args: { timeoutMs: 5000 } })).toBe(5000 + 30_000)
  })
})

describe('writePendingReport — the report a closed app could not take', () => {
  let dir: string
  let infoPath: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-pending-'))
    infoPath = path.join(dir, 'orch-info.json')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const report = {
    sessionId: 'sess_1',
    cmd: 'send',
    args: {
      type: 'worker_done',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      outcome: 'succeeded',
      body: 'done\nand said so'
    },
    queuedAt: '2026-09-10T01:02:03.004Z',
    nonce: 'abcd1234'
  }

  it('writes the report where the app will look for it', async () => {
    const r = writePendingReport({ infoPath, ...report })
    expect(r.ok).toBe(true)
    const written = (r as { ok: true; path: string }).path
    expect(path.dirname(written)).toBe(pendingReportsDirFrom(infoPath))
    expect(parsePendingReport(await fs.readFile(written, 'utf8'))).toEqual({
      queuedAt: report.queuedAt,
      sessionId: report.sessionId,
      cmd: report.cmd,
      args: report.args
    })
  })

  // The window this whole path exists for is the app not running, and the moment the app comes back
  // is exactly the moment it reads the queue. A plain writeFileSync can be read half-written, and
  // the reader would find an unparseable file. So the report appears under its final name only once
  // it is whole -- the same temporary-name-then-rename the orchestration store already uses.
  it('leaves no working file beside the report it wrote', async () => {
    const r = writePendingReport({ infoPath, ...report })
    expect((r as { ok: true; path: string }).path.endsWith('.json')).toBe(true)
    expect(await fs.readdir(pendingReportsDirFrom(infoPath))).toEqual([
      path.basename((r as { ok: true; path: string }).path)
    ])
  })

  it('clears its working file when the report cannot be put in place', async () => {
    const name = pendingReportFileName({ queuedAt: report.queuedAt, nonce: report.nonce })
    // A directory standing exactly where the report has to land: the write goes through and the
    // rename cannot.
    await fs.mkdir(path.join(pendingReportsDirFrom(infoPath), name), { recursive: true })
    const r = writePendingReport({ infoPath, ...report })
    expect(r.ok).toBe(false)
    expect(await fs.readdir(pendingReportsDirFrom(infoPath))).not.toContain(
      pendingReportTempName(name)
    )
  })

  it('makes the folder on the first report — nothing else creates it', async () => {
    writePendingReport({ infoPath, ...report })
    expect((await fs.stat(pendingReportsDirFrom(infoPath))).isDirectory()).toBe(true)
  })

  it('keeps two reports queued in the same millisecond apart', async () => {
    writePendingReport({ infoPath, ...report })
    writePendingReport({ infoPath, ...report, nonce: 'ffff0000' })
    expect((await fs.readdir(pendingReportsDirFrom(infoPath))).length).toBe(2)
  })

  it('answers with an error instead of throwing when the queue cannot be written', async () => {
    // A file where the folder has to go: the last line of defence failing, which the caller has to
    // be able to tell the agent about rather than crash on.
    await fs.writeFile(pendingReportsDirFrom(infoPath), 'in the way', 'utf8')
    const r = writePendingReport({ infoPath, ...report })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain(pendingReportsDirFrom(infoPath))
  })
})

describe('닿지 못했을 때의 코드', () => {
  // 스크립트가 "앱이 없다"(3)와 "명령이 실패했다"(1)를 가를 수 있어야 한다. 실제 CLI 로 돌려
  // 보고서야 나왔다 — 그 전에는 둘 다 1 이었다.
  it('앱을 찾지 못한 것은 HOST_NOT_RUNNING 이고 종료 코드 3 이다', () => {
    const e = JSON.parse(errorOutput('cannot read …', 'HOST_NOT_RUNNING'))
    expect(e.error.code).toBe('HOST_NOT_RUNNING')
    expect(exitCodeFor('HOST_NOT_RUNNING')).toBe(3)
  })
})

describe('출력 모드', () => {
  // **TTY 로 고를 수가 없다.** 이 CLI 는 ELECTRON_RUN_AS_NODE 로 도는 electron.exe 이고,
  // 진짜 콘솔에서도 isTTY 가 undefined 다(같은 콘솔에서 node 는 true). 그래서 기본은 JSON 이다.
  it('기본은 JSON 이고 사람용은 켜는 것이다', () => {
    expect(outputMode({ json: false, human: false, quiet: false })).toBe('json')
    expect(outputMode({ json: false, human: true, quiet: false })).toBe('human')
    expect(outputMode({ json: false, human: false, quiet: true })).toBe('quiet')
    expect(outputMode({ json: true, human: false, quiet: false })).toBe('json')
  })

  // 한쪽을 조용히 무시하면 사람은 자기가 친 것이 들었다고 믿는다
  it('모드를 둘 이상 주면 거절하고 무엇을 줘는지 말한다', () => {
    const r = outputMode({ json: true, human: false, quiet: true })
    expect(typeof r).toBe('object')
    expect((r as { error: string }).error).toBe('--json and --quiet ask for different things; pick one')
    expect(typeof outputMode({ json: false, human: true, quiet: true })).toBe('object')
  })
})

describe('renderOk / renderErr', () => {
  const jobs = [{ id: 'job_1', objective: 'o', outcome: 'running', progress: { done: 1, total: 2 } }]

  it('json 은 봉투다', () => {
    expect(JSON.parse(renderOk('jobs-list', jobs, 'json'))).toEqual({
      ok: true,
      data: { jobs }
    })
  })

  it('human 은 칸을 맞춘 표다', () => {
    expect(renderOk('jobs-list', jobs, 'human')).toBe('RUNNING  job_1  o  1/2')
  })

  it('quiet 은 id 만 낸다', () => {
    expect(renderOk('jobs-list', jobs, 'quiet')).toBe('job_1')
  })

  // 사람용이 없는 명령은 JSON 으로 되돌린다 — 억지로 표를 씨우면 가이드가 시키는 것을 못 읽는다
  it('사람용이 없는 명령은 human 에서도 JSON 이다', () => {
    const out = renderOk('dispatch-show', { id: 'd1' }, 'human')
    expect(JSON.parse(out)).toEqual({ ok: true, data: { id: 'd1' } })
  })

  it('사람에게는 봉투가 아니라 문장이다', () => {
    expect(renderErr('unknown run: nope', 'NOT_FOUND', 'human')).toBe('error: unknown run: nope')
    expect(JSON.parse(renderErr('x', 'NOT_FOUND', 'json')).error.code).toBe('NOT_FOUND')
  })
})
