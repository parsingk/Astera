import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exitCodeFor } from '../core/orchestration/cliOutput'
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import {
  errorOutput,
  exitCodeForStatus,
  ensureTrailingNewline,
  applyStdin,
  clientTimeoutMs,
  argsForCall,
  callHost,
  connectFailureEnd,
  SILENT_HOST_CODE,
  resolveGuidePath,
  readGuide,
  outputMode,
  renderErr,
  renderOk,
  startKeepalive,
  writePendingReport
} from './run'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'
import { KEEPALIVE_MS } from '../core/orchestration/cliKeepalive'
import type { HostConnection } from '../core/host/connect'
import type { ClientMessage, HostMessage } from '../core/host/protocol'
import {
  parsePendingReport,
  pendingReportFileName,
  pendingReportTempName,
  pendingReportsDirIn
} from '../core/orchestration/pendingReports'

describe('errorOutput', () => {
  // 스크립트가 기대는 것은 봉투다(설계 §7) — 코드는 기계의 것이고 문구는 사람의 것이다.
  it('오류를 봉투 한 줄로 감싼다', () => {
    expect(JSON.parse(errorOutput('boom'))).toEqual({
      ok: false,
      error: { code: 'FAILED', message: 'boom', details: {}, nextSteps: [] }
    })
  })
  it('코드를 주면 그것이 실린다', () => {
    expect(JSON.parse(errorOutput('nope', 'NOT_FOUND')).error.code).toBe('NOT_FOUND')
  })
  // 어떤 명령이 실패했는지가 다음에 칠 것을 가른다 — 봉투를 짓는 자리에서 그것을 받는 이유다.
  it('명령을 주면 그 명령에 맞는 nextSteps 가 실린다', () => {
    expect(JSON.parse(errorOutput('unknown job: x', 'NOT_FOUND', 'jobs-get')).error.nextSteps).toEqual([
      'astera jobs list'
    ])
    expect(JSON.parse(errorOutput('unknown job: x', 'NOT_FOUND')).error.nextSteps).toEqual(['astera help'])
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

describe('argsForCall — run-create의 --cwd 기본값 (task-13a)', () => {
  // run-create 는 --cwd 생략 시 process.cwd() 로 메꾸지만 그건 답하는 프로세스(Host)의 cwd 라
  // CLI 프로세스와 무관하다 — CLI 가 자기 cwd 를 채워 보내야 한다.
  it('--cwd 없이 run-create를 보내면 CLI의 cwd를 args에 채운다', () => {
    expect(argsForCall({ cmd: 'run-create', args: { objective: 'o' }, cwd: 'D:/my-cwd' })).toEqual({
      objective: 'o',
      cwd: 'D:/my-cwd'
    })
  })
  it('--cwd가 명시되면 CLI의 cwd보다 그것이 이긴다', () => {
    expect(
      argsForCall({ cmd: 'run-create', args: { objective: 'o', cwd: 'D:/explicit' }, cwd: 'D:/my-cwd' })
    ).toEqual({ objective: 'o', cwd: 'D:/explicit' })
  })
  it('run-create가 아닌 명령에는 CLI의 cwd를 채우지 않는다', () => {
    expect(argsForCall({ cmd: 'tasks-list', args: {}, cwd: 'D:/my-cwd' })).toEqual({})
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

describe('writePendingReport — the report a closed Host could not take', () => {
  let profileDir = ''
  beforeEach(async () => {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-pending-'))
  })
  afterEach(async () => {
    await fs.rm(profileDir, { recursive: true, force: true })
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
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(true)
    const written = (r as { ok: true; path: string }).path
    expect(path.dirname(written)).toBe(pendingReportsDirIn(profileDir))
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
    const r = writePendingReport({ profileDir, ...report })
    expect((r as { ok: true; path: string }).path.endsWith('.json')).toBe(true)
    expect(await fs.readdir(pendingReportsDirIn(profileDir))).toEqual([
      path.basename((r as { ok: true; path: string }).path)
    ])
  })

  it('clears its working file when the report cannot be put in place', async () => {
    const name = pendingReportFileName({ queuedAt: report.queuedAt, nonce: report.nonce })
    // A directory standing exactly where the report has to land: the write goes through and the
    // rename cannot.
    await fs.mkdir(path.join(pendingReportsDirIn(profileDir), name), { recursive: true })
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(false)
    expect(await fs.readdir(pendingReportsDirIn(profileDir))).not.toContain(
      pendingReportTempName(name)
    )
  })

  it('makes the folder on the first report — nothing else creates it', async () => {
    writePendingReport({ profileDir, ...report })
    expect((await fs.stat(pendingReportsDirIn(profileDir))).isDirectory()).toBe(true)
  })

  it('keeps two reports queued in the same millisecond apart', async () => {
    writePendingReport({ profileDir, ...report })
    writePendingReport({ profileDir, ...report, nonce: 'ffff0000' })
    expect((await fs.readdir(pendingReportsDirIn(profileDir))).length).toBe(2)
  })

  it('answers with an error instead of throwing when the queue cannot be written', async () => {
    // A file where the folder has to go: the last line of defence failing, which the caller has to
    // be able to tell the agent about rather than crash on.
    await fs.mkdir(path.dirname(pendingReportsDirIn(profileDir)), { recursive: true })
    await fs.writeFile(pendingReportsDirIn(profileDir), 'in the way', 'utf8')
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain(pendingReportsDirIn(profileDir))
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

// F44: 파일로 답하는 길이 서 있는 전제는 "아무도 이 파일을 쓰고 있지 않다" 하나다. 접속 실패
// 세 가지 중 그것을 뜻하는 것은 하나뿐인데, 셋 다 파일로 떨어지고 있었다.
describe('connectFailureEnd — 접속 실패 셋을 가른다', () => {
  const addr = '\\\\.\\pipe\\astera-host-x'

  it('아무것도 없었을 때만 파일로 답한다', () => {
    expect(connectFailureEnd({ error: 'unreachable', address: addr })).toEqual({ fallback: true })
  })

  // 판을 보고 거절한 Host 는 돌고 있고 파일을 쥐고 있다. `orch` 를 알리지 않는 Host 와 같은 자리다.
  it('판이 갈린 것은 VERSION_MISMATCH 이고 파일을 읽지 않는다', () => {
    const end = connectFailureEnd({ error: 'protocol', address: addr })
    expect(end.fallback).toBe(false)
    expect((end as { code: string }).code).toBe('VERSION_MISMATCH')
    expect(exitCodeFor('VERSION_MISMATCH')).toBe(9)
    expect((end as { message: string }).message).toContain(addr)
  })

  // 파이프는 열렸는데 hello 가 안 왔다 — 살아 있는데 답하지 않는 Host 이고, 이 저장소는 그것을
  // 위한 회복 코드를 따로 두고 있다. 그 파일을 읽어 running: false 로 답하면 거짓말이다.
  it('답하지 않는 것은 TIMEOUT 이고 파일을 읽지 않는다', () => {
    const end = connectFailureEnd({ error: 'timeout', address: addr })
    expect(end.fallback).toBe(false)
    expect((end as { code: string }).code).toBe('TIMEOUT')
    expect(exitCodeFor('TIMEOUT')).toBe(7)
  })

  // hello 전의 침묵과 답 전의 침묵은 같은 사실이다. `stuck` 은 1 로 끝나고 있었고,
  // 그러면 스크립트가 "살아 있는데 답하지 않는 Host" 를 두 번 분기해야 한다.
  it('두 침묵은 한 코드를 쓴다', () => {
    expect((connectFailureEnd({ error: 'timeout', address: addr }) as { code: string }).code).toBe(
      SILENT_HOST_CODE
    )
    expect(exitCodeFor(SILENT_HOST_CODE)).toBe(7)
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
    expect(renderErr({ code: 'NOT_FOUND', message: 'unknown run: nope' }, 'human')).toBe(
      'error: unknown run: nope\ntry:\n  astera help'
    )
    expect(JSON.parse(renderErr({ code: 'NOT_FOUND', message: 'x' }, 'json')).error.code).toBe('NOT_FOUND')
  })

  // 사람도 다음에 칠 것을 받는다. 봉투에는 이미 실려 있으므로 JSON 쪽에 문장을 덧붙이지 않는다 —
  // 같은 것을 두 모양으로 두 번 내보내면 읽는 쪽이 어느 것이 계약인지 모른다.
  it('사람용에는 칠 명령이 붙고, JSON 에는 봉투 안에만 있다', () => {
    expect(renderErr({ code: 'HOST_NOT_RUNNING', message: 'cannot reach the Host' }, 'human')).toBe(
      'error: cannot reach the Host\ntry:\n  astera host start'
    )
    const json = renderErr({ code: 'HOST_NOT_RUNNING', message: 'cannot reach the Host' }, 'json')
    expect(json).not.toContain('try:')
    expect(JSON.parse(json).error.nextSteps).toEqual(['astera host start'])
  })

  // 칠 것이 없는 코드는 줄을 늘리지 않는다
  it('할 것이 없으면 문장 하나뿐이다', () => {
    expect(renderErr({ code: 'FAILED', message: 'boom' }, 'human')).toBe('error: boom')
  })
})

describe('callHost — 명령 하나를 Host 에 묻는다', () => {
  /** `connectHost` 가 돌려주는 것 중 이 함수가 쓰는 것만. 소켓 없이 순서를 재기 위한 것이다. */
  const fakeConn = (): {
    conn: HostConnection
    sent: ClientMessage[]
    answer(m: HostMessage): void
    drop(): void
  } => {
    const sent: ClientMessage[] = []
    const listeners = new Set<(m: HostMessage) => void>()
    const closers = new Set<() => void>()
    return {
      sent,
      answer: (m) => {
        for (const cb of [...listeners]) cb(m)
      },
      drop: () => {
        for (const cb of [...closers]) cb()
      },
      conn: {
        hello: { host: '1', pid: 1, startedAt: 'T', features: ['orch'] },
        call: (m) => sent.push(m),
        onMessage: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        onClose: (cb) => {
          closers.add(cb)
          return () => closers.delete(cb)
        },
        close: () => {}
      }
    }
  }

  it('명령과 인자와 세션을 한 줄로 보내고 그 답을 돌려준다', async () => {
    const f = fakeConn()
    const p = callHost({
      conn: f.conn,
      cmd: 'jobs-list',
      args: { limit: 5 },
      sessionId: 'sess_1',
      timeoutMs: 1000
    })
    expect(f.sent[0]).toMatchObject({
      t: 'orch-call',
      cmd: 'jobs-list',
      args: { limit: 5 },
      session: 'sess_1'
    })
    const call = (f.sent[0] as { call: string }).call
    f.answer({ t: 'orch-result', call, status: 200, body: { jobs: [] } })
    expect(await p).toEqual({ status: 200, body: { jobs: [] } })
  })

  // 답은 자기 call 을 이름으로 부른다 — 남의 것을 자기 답으로 읽으면 안 된다.
  it('다른 call 의 답은 자기 답이 아니다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'status', args: {}, sessionId: '', timeoutMs: 50 })
    f.answer({ t: 'orch-result', call: 'someone_else', status: 200, body: { running: true } })
    expect(await p).toEqual({ stuck: expect.stringContaining('did not answer status') })
  })

  // 답 전에 끊긴 것은 Host 가 사라진 것이다 — 보고가 파일에 적히는 쪽으로 가야 한다.
  it('답 전에 연결이 끊기면 닿지 못한 것이다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'send', args: {}, sessionId: '', timeoutMs: 1000 })
    f.drop()
    expect(await p).toEqual({ unreachable: expect.stringContaining('closed the connection') })
  })

  // 시한을 넘긴 것은 연결은 됐는데 저쪽이 멈춘 것이다 — 그냥 실패이고, 보고를 적어 두지 않는다.
  it('시한을 넘기면 멈춘 것으로 답한다', async () => {
    const f = fakeConn()
    expect(
      await callHost({ conn: f.conn, cmd: 'ask', args: {}, sessionId: '', timeoutMs: 10 })
    ).toEqual({ stuck: expect.stringContaining('within 10ms') })
  })

  // 끊긴 뒤에 오는 답은 없지만, 두 번 답하는 Host 에 두 번 resolve 되면 안 된다.
  it('한 번만 답한다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'status', args: {}, sessionId: '', timeoutMs: 1000 })
    const call = (f.sent[0] as { call: string }).call
    f.answer({ t: 'orch-result', call, status: 200, body: 1 })
    f.answer({ t: 'orch-result', call, status: 500, body: 2 })
    expect(await p).toEqual({ status: 200, body: 1 })
  })
})

// 텍스트 가드. **이 가지에서 `--human` 이 봉투를 찍은 것이 네 번이고, 그때마다 고친 것은 그 자리
// 하나였다** — help 의 두 자리, browser-help 의 두 자리, browser js --file, 그리고 Host 에 닿지
// 못한 자리. 자리를 세는 한 다음에 또 잊는다. 그래서 잊을 수 없는 모양으로 바꾸고(main 의 `fail`),
// 그 모양이 유지되는 것을 여기서 지킨다: 모드가 정해진 뒤로는 봉투를 짓는 호출이 하나도 없어야
// 한다. 새 실패 경로를 더하는 사람이 기본값으로 얻는 것이 모드를 따르는 쪽이 된다.
describe('run.ts — 모드가 정해진 뒤의 실패는 한 문으로만 나간다', () => {
  const runSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run.ts'),
    'utf8'
  )

  /** `fail` 이 세워진 자리 아래 전부. 표식이 사라졌으면 조용히 빈 것을 훑는 대신 여기서 던진다. */
  function afterSeam(): string {
    const at = runSource.indexOf('// FAIL_SEAM')
    if (at < 0) throw new Error('run.ts has no FAIL_SEAM marker — did the fail() funnel move?')
    return runSource.slice(at)
  }

  // 실패를 내보내는 세 가지. 성공 쪽은 `renderOk` 한 곳으로 이미 모여 있고, `agent-context` 만
  // 일부러 `okEnvelope` 를 직접 쓴다 — 스키마는 모드와 무관하게 JSON 이다.
  //
  // **이 가드가 무엇을 잡는지 분명히 해 둔다: 사고이지 우회가 아니다.** 한 파일의 글자만 보므로,
  // `main` 위나 다른 모듈에 찍는 함수를 두고 아래에서 부르면 지나가고, `process.stdout.write` 로
  // 직접 써도 지나간다. 그것들은 가드를 알고 돌아가는 일이라 리뷰의 몫이다. 잡으려는 것은 실패
  // 경로를 하나 더 붙이면서 `fail` 을 쓰지 않는, 그럴 법한 실수다.
  it('봉투를 짓는 실패 호출이 하나도 남아 있지 않다', () => {
    for (const call of ['errorOutput(', 'errEnvelope(', 'renderErr('])
      expect(afterSeam().split(call).length - 1, `${call} is called after the seam`).toBe(0)
  })

  // **아무것도 안 찍고 끝내는 것이 이 집안에서 가장 나쁘다.** 봉투를 잘못 찍는 것은 보이기라도
  // 하는데, 맨 `process.exit(2)` 는 스크립트에게 코드만 주고 왜인지는 아무 데도 남기지 않는다.
  // 그래서 0 이 아닌 종료는 전부 `fail` 을 지나야 하고, 지나지 않는 자리는 그 줄에서 그렇게 말해야
  // 한다. 지금 면제는 하나이고(`host-*` 는 성공 모양의 본문에 0 아닌 코드를 붙인다) 그 수를 센다.
  it('0 이 아닌 종료는 fail 을 지나거나, 그 자리에서 면제라고 말한다', () => {
    const lines = afterSeam().split('\n')
    const exits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('process.exit('))
    expect(exits.length).toBeGreaterThan(0)
    const bare = exits.filter(({ l }) => !l.includes('process.exit(0)'))
    for (const { l, i } of bare) {
      // 바로 앞의 주석 덩이에 표식이 있으면 된다 — 한 줄짜리 표식을 강요하면 이유를 적을 자리가 없다
      const preface = lines.slice(Math.max(0, i - 8), i).join('\n')
      expect(preface.includes('FAIL_SEAM:exempt'), `unmarked non-zero exit: ${l.trim()}`).toBe(true)
    }
    expect(bare.length, 'the number of exemptions changed').toBe(1)
  })

  // 앞선 세 자리는 아직 모드가 없어서 봉투로 나간다 — 그것이 errorOutput 이 남아 있는 이유이고,
  // 그 수가 늘면 모드 뒤의 실패가 앞으로 새어 나온 것이다.
  it('모드 앞의 봉투는 셋뿐이다 — 사용법·파서·모드 자신', () => {
    const before = runSource.slice(0, runSource.indexOf('// FAIL_SEAM'))
    expect(before.split('out(errorOutput(').length - 1).toBe(3)
  })
})

// **긴 기다림이 조용하면 멈춘 Host 와 구별되지 않는다.** 이 저장소는 그 침묵에 한 번 물렸고
// (docs/2026-09-22-host-unresponsive-recovery-design.md), 그래서 기다리는 동안 살아 있다는 줄을
// stderr 에 낸다 — stdout 은 결과 하나뿐이어야 하므로 거기 섞일 수 없다.
describe('startKeepalive — 기다리는 동안 내는 줄', () => {
  let clock = 0
  const now = (): number => clock
  /** 시계와 타이머를 **조금씩 함께** 민다. 한 번에 밀면 그 사이에 오갔어야 할 pong 이 전부
   *  같은 순간에 몰려, 건강한 Host 도 한 간격 내내 조용했던 것으로 읽힌다. */
  const pass = (ms: number): void => {
    for (let i = 0; i < ms; i += 1000) {
      clock += 1000
      vi.advanceTimersByTime(1000)
    }
  }

  /** `answers` 가 이 Host 의 상태다: ping 에 곧바로 pong 하는 Host 와, 받고도 아무 말이 없는
   *  Host — 바로 그 둘을 이 줄이 갈라야 한다. */
  const fakeConn = (
    o: { features: string[]; answers: boolean }
  ): {
    conn: Pick<HostConnection, 'hello' | 'call' | 'onMessage'>
    sent: ClientMessage[]
  } => {
    const sent: ClientMessage[] = []
    const listeners = new Set<(m: HostMessage) => void>()
    return {
      sent,
      conn: {
        hello: { host: '1', pid: 1, startedAt: 'T', features: o.features },
        call: (m) => {
          sent.push(m)
          if (o.answers && m.t === 'ping') for (const cb of [...listeners]) cb({ t: 'pong', seq: m.seq })
        },
        onMessage: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        }
      }
    }
  }

  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const lines: string[] = []
  const start = (o: {
    cmd: string
    args?: Record<string, unknown>
    enabled?: boolean
    features?: string[]
    answers?: boolean
  }): { conn: ReturnType<typeof fakeConn>; keepalive: { stop: () => void } } => {
    lines.length = 0
    const conn = fakeConn({ features: o.features ?? ['orch', 'ping'], answers: o.answers !== false })
    const keepalive = startKeepalive({
      conn: conn.conn,
      cmd: o.cmd,
      args: o.args ?? {},
      enabled: o.enabled ?? true,
      tickMs: 5_000,
      lineMs: 15_000,
      now,
      write: (l) => lines.push(l)
    })
    return { conn, keepalive }
  }

  // 기다리지 않는 출력에 살아 있다는 줄이 붙으면 그 줄은 아무것도 뜻하지 않게 된다.
  it('기다리지 않는 명령에는 아무것도 내지 않는다', () => {
    const { conn } = start({ cmd: 'jobs-list' })
    pass(60_000)
    expect(lines).toEqual([])
    expect(conn.sent).toEqual([])
  })

  it('--no-keepalive 는 한 줄도 내지 않고 묻지도 않는다', () => {
    const { conn } = start({ cmd: 'runs-wait', enabled: false })
    pass(60_000)
    expect(lines).toEqual([])
    expect(conn.sent).toEqual([])
  })

  it('기다리는 동안 한 줄씩 내고, 답이 오면 멈춘다', () => {
    const { keepalive } = start({ cmd: 'runs-wait' })
    pass(15_000)
    expect(lines).toEqual(['waiting for runs wait, 15s so far; the Host answered 5s ago'])
    pass(15_000)
    expect(lines).toHaveLength(2)
    keepalive.stop()
    pass(60_000)
    expect(lines).toHaveLength(2)
  })

  // 줄보다 자주 묻지 않으면, 건강한 Host 도 언제나 "한 간격 전에 답했다" 가 되어 그 칸이
  // 아무것도 말하지 않는다.
  it('ping 은 줄보다 자주 간다', () => {
    const { conn } = start({ cmd: 'ask' })
    pass(15_000)
    expect(conn.sent).toEqual([
      { t: 'ping', seq: 1 },
      { t: 'ping', seq: 2 },
      { t: 'ping', seq: 3 }
    ])
  })

  // **이 줄이 있는 이유가 "멈춘 Host 인가" 다.** 이쪽이 살아 있다는 것만 찍으면 그 질문에
  // 답하지 못한다.
  it('Host 가 답을 그치면 줄이 그 사실을 말한다', () => {
    const { conn } = start({ cmd: 'ask', answers: false })
    pass(45_000)
    // 받기는 받았다 — 답이 없을 뿐이고, 그것이 이 줄이 말해야 하는 사실이다
    expect(conn.sent).toHaveLength(9)
    expect(lines[0]).toContain('the Host has not answered a ping for 15s')
    expect(lines[2]).toContain('the Host has not answered a ping for 45s')
  })

  // 모르는 메시지를 흘려버리는 Host 에 물으면 답이 영영 오지 않고, 그 침묵은 고장이 아니다
  it('ping 을 모르는 Host 에는 묻지 않고, 아는 척도 하지 않는다', () => {
    const { conn } = start({ cmd: 'check', args: { wait: true }, features: ['orch'], answers: false })
    pass(15_000)
    expect(conn.sent).toEqual([])
    expect(lines).toEqual(['waiting for check, 15s so far'])
  })
})
