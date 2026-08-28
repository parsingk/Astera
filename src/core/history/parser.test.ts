import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  lastTurns,
  parseTranscriptForResume,
  parseTranscriptMeta,
  parseTranscriptPreview,
  parseTranscriptTail
} from './parser'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-parser-'))
})

const line = (obj: unknown): string => JSON.stringify(obj)

async function write(name: string, lines: string[]): Promise<string> {
  const file = path.join(tmp, name)
  await fs.writeFile(file, lines.join('\n'), 'utf8')
  return file
}

describe('parseTranscriptMeta', () => {
  it('sessionId·cwd·제목(첫 사용자 메시지)을 추출한다', async () => {
    const file = await write('a.jsonl', [
      line({ type: 'summary', summary: 'ignored' }),
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: 'D:\\proj',
        message: { role: 'user', content: '  로그인   버그 고쳐줘  ' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta).toEqual({
      sessionId: 'sess-1',
      cwd: 'D:\\proj',
      title: '로그인 버그 고쳐줘',
      rootUuid: null,
      isSidechain: false,
      isHelper: false
    })
  })

  it('isMeta 레코드는 제목이 되지 않는다 — 스킬 본문이 대화 제목으로 걸리던 자리다', async () => {
    const file = await write('meta-title.jsonl', [
      line({
        type: 'user',
        sessionId: 'sess-m',
        cwd: 'D:\\proj',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: C:/skills/artifact-design' }]
        }
      }),
      line({ type: 'user', message: { role: 'user', content: '진짜 첫 요청' } })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.title).toBe('진짜 첫 요청')
  })

  it('첫 줄이 queue-operation이면 isHelper=true (HUD 헬퍼 세션, 실측 91%)', async () => {
    const file = await write('helper.jsonl', [
      line({ type: 'queue-operation', sessionId: 'helper-1' }),
      line({
        type: 'user',
        sessionId: 'helper-1',
        cwd: 'D:\\proj',
        message: { role: 'user', content: '무시되어야 함' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.isHelper).toBe(true)
    expect(meta.isSidechain).toBe(false)
  })

  it('첫 줄이 agent-name / bridge-session이면 isHelper=true (비대화 기록 파일)', async () => {
    const bridge = await write('bridge.jsonl', [
      line({ type: 'bridge-session' }),
      line({ type: 'bridge-session' })
    ])
    const agent = await write('agent.jsonl', [line({ type: 'agent-name', name: 'x' })])
    expect((await parseTranscriptMeta(bridge)).isHelper).toBe(true)
    expect((await parseTranscriptMeta(agent)).isHelper).toBe(true)
  })

  // 이 테스트는 이전에 반대를 못박고 있었다(ai-title 이 첫 줄이면 isHelper=true). 실측이 그것을
  // 뒤집었다 — 이 저장소를 만드는 데 쓰인 28MB 세션이 정확히 그 모양이었고, 목록에서 통째로
  // 빠져 있었다. 제목 기록은 첫 사용자 줄보다 먼저 흘러나올 수 있다.
  it('첫 줄이 ai-title 이어도 대화가 있으면 isHelper=false (제목 기록이 먼저 나온 실제 세션)', async () => {
    const file = await write('real.jsonl', [
      line({ type: 'ai-title', title: '제목생성' }),
      line({
        type: 'user',
        sessionId: 'real-1',
        cwd: 'D:\\proj',
        message: { role: 'user', content: '이건 실제 대화다' }
      }),
      line({ type: 'assistant', message: { role: 'assistant', content: '네' } })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.isHelper).toBe(false)
    expect(meta.sessionId).toBe('real-1')
    expect(meta.title).toBe('이건 실제 대화다')
  })

  it('첫 줄이 queue-operation 이면 대화가 있어도 isHelper=true 그대로다', async () => {
    const file = await write('hud.jsonl', [
      line({ type: 'queue-operation', sessionId: 'hud-1' }),
      line({
        type: 'user',
        sessionId: 'hud-1',
        cwd: 'D:\\proj',
        message: { role: 'user', content: '주제를 한 줄로' }
      }),
      line({ type: 'assistant', message: { role: 'assistant', content: '한 줄' } })
    ])
    expect((await parseTranscriptMeta(file)).isHelper).toBe(true)
  })

  it('isSidechain:true 줄이 있으면 isSidechain=true (레거시 사이드체인)', async () => {
    const file = await write('side.jsonl', [
      line({
        type: 'user',
        sessionId: 'side-1',
        cwd: 'D:\\proj',
        isSidechain: true,
        message: { role: 'user', content: '사이드체인 메시지' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.isSidechain).toBe(true)
    expect(meta.isHelper).toBe(false)
  })

  it('일반 대화형 세션은 isSidechain·isHelper 둘 다 false', async () => {
    const file = await write('normal.jsonl', [
      line({
        type: 'user',
        sessionId: 'normal-1',
        cwd: 'D:\\proj',
        message: { role: 'user', content: '평범한 대화' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.isSidechain).toBe(false)
    expect(meta.isHelper).toBe(false)
  })

  it('배열형 content에서 text 블록을 제목으로 쓴다', async () => {
    const file = await write('b.jsonl', [
      line({
        type: 'user',
        sessionId: 's',
        cwd: 'D:\\p',
        message: { role: 'user', content: [{ type: 'text', text: '배열형 메시지' }] }
      })
    ])
    expect((await parseTranscriptMeta(file)).title).toBe('배열형 메시지')
  })

  it('깨진 줄은 건너뛰고 크래시하지 않는다', async () => {
    const file = await write('c.jsonl', [
      '{{{{not json',
      line({ type: 'user', sessionId: 's2', cwd: 'D:\\p', message: { role: 'user', content: 'ok' } })
    ])
    expect((await parseTranscriptMeta(file)).sessionId).toBe('s2')
  })

  it('maxLines 안에서 못 찾으면 null을 돌려준다 (호출자가 파일명 폴백)', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => line({ type: 'progress', i }))
    const file = await write('d.jsonl', filler)
    const meta = await parseTranscriptMeta(file, 50)
    expect(meta).toEqual({
      sessionId: null,
      cwd: null,
      title: null,
      rootUuid: null,
      isSidechain: false,
      isHelper: false
    })
  })

  it('긴 제목은 80자로 자른다', async () => {
    const file = await write('e.jsonl', [
      line({ type: 'user', sessionId: 's', cwd: 'c', message: { role: 'user', content: 'x'.repeat(200) } })
    ])
    expect((await parseTranscriptMeta(file)).title).toHaveLength(81) // 80 + '…'
  })

  it('유효한 JSON이지만 객체가 아닌 줄들(null, 문자열, 숫자, 배열)은 건너뛰고 크래시하지 않는다', async () => {
    const file = await write('f.jsonl', [
      'null',
      '"문자열 JSON"',
      '123',
      '[1,2,3]',
      line({ type: 'user', sessionId: 's-obj', cwd: 'D:\\obj', message: { role: 'user', content: '유효한 메타' } })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.sessionId).toBe('s-obj')
    expect(meta.cwd).toBe('D:\\obj')
    expect(meta.title).toBe('유효한 메타')
  })

  it('caveat(로컬 커맨드 기록)로 시작하는 세션은 제목이 다음 real 사용자 메시지로 잡힌다', async () => {
    const file = await write('caveat.jsonl', [
      line({
        type: 'user',
        sessionId: 'caveat-1',
        cwd: 'D:\\p',
        message: { role: 'user', content: '<local-command-caveat>커맨드 기록</local-command-caveat>' }
      }),
      line({
        type: 'user',
        message: { role: 'user', content: '진짜 사용자 메시지' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.title).toBe('진짜 사용자 메시지')
  })

  it('rootUuid는 real 여부와 무관하게 첫 user 줄의 uuid를 취한다', async () => {
    const file = await write('root.jsonl', [
      line({
        type: 'user',
        sessionId: 'root-1',
        cwd: 'D:\\p',
        uuid: 'uuid-root',
        message: { role: 'user', content: '<local-command-caveat>기록</local-command-caveat>' }
      }),
      line({
        type: 'user',
        uuid: 'uuid-second',
        message: { role: 'user', content: '진짜 메시지' }
      })
    ])
    const meta = await parseTranscriptMeta(file)
    expect(meta.rootUuid).toBe('uuid-root')
  })

  it('첫 user 줄에 uuid가 없으면 rootUuid는 null', async () => {
    const file = await write('noroot.jsonl', [
      line({ type: 'user', sessionId: 's', cwd: 'D:\\p', message: { role: 'user', content: '메시지' } })
    ])
    expect((await parseTranscriptMeta(file)).rootUuid).toBeNull()
  })
})

describe('parseTranscriptTail', () => {
  it('isMeta 레코드는 마지막 사용자 메시지도 아니고 답변 대기 판정도 뒤집지 않는다', async () => {
    const file = await write('tail-meta.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '질문' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } }),
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: C:/skills/x' }] }
      })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.lastUserTitle).toBe('질문')
    expect(tail.awaitingReply).toBe(true)
  })

  it('마지막 real user 메시지를 lastUserTitle로 추출한다', async () => {
    const file = await write('tail-a.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '첫 메시지' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변1' }] } }),
      line({ type: 'user', message: { role: 'user', content: '마지막 메시지' } })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.lastUserTitle).toBe('마지막 메시지')
  })

  it('마지막 의미 메시지가 assistant면 awaitingReply=true', async () => {
    const file = await write('tail-b.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '질문' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.awaitingReply).toBe(true)
  })

  it('마지막 의미 메시지가 user면 awaitingReply=false', async () => {
    const file = await write('tail-c.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '질문' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } }),
      line({ type: 'user', message: { role: 'user', content: '추가 질문' } })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.awaitingReply).toBe(false)
  })

  it('tool_result-only user 줄은 마지막 의미 메시지 판정에서 건너뛴다', async () => {
    const file = await write('tail-d.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '질문' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '결과' }] }
      })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.awaitingReply).toBe(true) // tool_result 줄은 건너뛰고 그 앞의 assistant가 마지막 의미 메시지
    expect(tail.lastUserTitle).toBe('질문')
  })

  it('caveat·중단 마커 메시지는 무시한다', async () => {
    const file = await write('tail-e.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '진짜 메시지' } }),
      line({ type: 'user', message: { role: 'user', content: '<command-name>ls</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } })
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.lastUserTitle).toBe('진짜 메시지')
    expect(tail.awaitingReply).toBe(false)
  })

  it('tailBytes보다 큰 파일에서 앞부분이 잘려도 마지막 메시지를 정상 추출한다', async () => {
    const filler = Array.from({ length: 200 }, (_, i) =>
      line({ type: 'user', message: { role: 'user', content: `필러 메시지 ${i}` } })
    )
    const file = await write('tail-big.jsonl', [
      ...filler,
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '마지막 답변' }] } })
    ])
    const tail = await parseTranscriptTail(file, 300) // 작은 tailBytes로 앞부분이 잘리는 상황을 재현
    expect(tail.awaitingReply).toBe(true)
    expect(tail.lastUserTitle).not.toBeNull()
  })

  it('빈 파일/존재하지 않는 파일은 크래시 없이 기본값을 돌려준다', async () => {
    const missing = path.join(tmp, 'does-not-exist.jsonl')
    expect(await parseTranscriptTail(missing)).toEqual({ lastUserTitle: null, awaitingReply: false })
    const empty = await write('empty.jsonl', [])
    expect(await parseTranscriptTail(empty)).toEqual({ lastUserTitle: null, awaitingReply: false })
  })

  it('깨진 줄은 건너뛰고 크래시하지 않는다', async () => {
    const file = await write('tail-broken.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '정상 메시지' } }),
      '{{{not json'
    ])
    const tail = await parseTranscriptTail(file)
    expect(tail.lastUserTitle).toBe('정상 메시지')
  })
})

describe('제목에서 기계가 쓴 user 줄을 걸러낸다', () => {
  // 이 목록은 실측으로 모았다(parser.ts 의 MACHINE_USER_PREFIXES 주석). 걸러지지 않던 것들이
  // 목록의 제목으로 떠서 "무슨 세션이었나"를 읽을 수 없었다
  const noise = [
    '<task-notification> <task-id>a5079f895761d8526</task-id>',
    '<bash-stdout>{"stopped":"dsp_506882e8e232cea0"}</bash-stdout>',
    '<bash-input>git status</bash-input>',
    '<bash-stderr>fatal: not a git repository</bash-stderr>',
    '<local-command-stdout>...</local-command-stdout>',
    '<system-reminder>기억하세요</system-reminder>',
    'This session is being continued from a previous conversation that ran out of context'
  ]

  it('마지막 user 줄이 기계 기록이면 그 앞의 실제 사용자 말을 제목으로 쓴다', async () => {
    const file = await write('noisy.jsonl', [
      line({ type: 'user', sessionId: 's', cwd: 'D:\\p', message: { role: 'user', content: '실제로 친 말' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: '네' } }),
      ...noise.map((t) => line({ type: 'user', message: { role: 'user', content: t } }))
    ])
    expect((await parseTranscriptTail(file)).lastUserTitle).toBe('실제로 친 말')
  })

  it('meta 의 제목도 같은 규칙을 쓴다 — 기계 기록이 첫 줄이어도 건너뛴다', async () => {
    const file = await write('noisy-head.jsonl', [
      line({ type: 'user', message: { role: 'user', content: noise[0] } }),
      line({ type: 'user', sessionId: 's', cwd: 'D:\\p', message: { role: 'user', content: '진짜 첫 말' } })
    ])
    expect((await parseTranscriptMeta(file)).title).toBe('진짜 첫 말')
  })
})

describe('lastTurns', () => {
  const u = (t: string) => ({ role: 'user' as const, text: t })
  const a = (t: string) => ({ role: 'assistant' as const, text: t })

  it('턴이 상한 이하면 그대로 두고 truncated=false', () => {
    const msgs = [u('q1'), a('a1'), u('q2'), a('a2')]
    expect(lastTurns(msgs, 10)).toEqual({ messages: msgs, truncated: false })
  })

  it('상한을 넘으면 마지막 상한 개 턴만 남기고 truncated=true', () => {
    const msgs = [u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')]
    expect(lastTurns(msgs, 2)).toEqual({
      messages: [u('q2'), a('a2'), u('q3'), a('a3')],
      truncated: true
    })
  })

  // 턴의 시작이 user 이므로, 남기는 첫 user 앞의 assistant 는 함께 떨어진다 — 그것이 턴의 뜻이다
  it('남기는 첫 user 앞의 assistant 는 떨어진다', () => {
    const msgs = [u('q1'), a('버려질 답'), u('q2')]
    expect(lastTurns(msgs, 1)).toEqual({ messages: [u('q2')], truncated: true })
  })

  it('user 메시지가 없으면 아무것도 자르지 않는다', () => {
    const msgs = [a('a1'), a('a2')]
    expect(lastTurns(msgs, 1)).toEqual({ messages: msgs, truncated: false })
  })
})

describe('parseTranscriptPreview', () => {
  // 방향이 뒤집힌 자리다. 예전에는 앞에서부터 200 개를 모아 "(앞부분만)" 을 보여 줬는데, 긴 세션에서
  // 그것은 몇 시간 전 이야기라 "무엇을 하고 있었나"에 답하지 못했다.
  it('턴이 많으면 **최근** 10 턴만 남기고 truncated=true', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 12; i++) {
      lines.push(line({ type: 'user', message: { role: 'user', content: `q${i}` } }))
      lines.push(
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } })
      )
    }
    const preview = await parseTranscriptPreview(await write('many.jsonl', lines))
    expect(preview.truncated).toBe(true)
    // 12 턴 중 마지막 10 턴 → q3 부터
    expect(preview.messages[0]).toEqual({ role: 'user', text: 'q3', timestamp: undefined })
    expect(preview.messages.at(-1)).toEqual({ role: 'assistant', text: 'a12', timestamp: undefined })
    expect(preview.messages).toHaveLength(20)
  })

  it('user/assistant 텍스트만 순서대로 모은다', async () => {
    const file = await write('p.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '질문' } }),
      line({ type: 'progress', data: 'skip' }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } })
    ])
    const preview = await parseTranscriptPreview(file)
    expect(preview.truncated).toBe(false)
    expect(preview.messages).toEqual([
      { role: 'user', text: '질문', timestamp: undefined },
      { role: 'assistant', text: '답변', timestamp: undefined }
    ])
  })

  it('maxMessages를 넘으면 truncated=true', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      line({ type: 'user', message: { role: 'user', content: `m${i}` } })
    )
    const preview = await parseTranscriptPreview(await write('q.jsonl', many), 5)
    expect(preview.messages).toHaveLength(5)
    expect(preview.truncated).toBe(true)
  })

  it('유효한 JSON이지만 객체가 아닌 줄들(null, 문자열, 숫자, 배열)은 건너뛰고 크래시하지 않는다', async () => {
    const file = await write('r.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '첫 메시지' } }),
      'null',
      '"문자열"',
      '42',
      '[1,2,3]',
      line({ type: 'assistant', message: { role: 'assistant', content: '두 번째 메시지' } })
    ])
    const preview = await parseTranscriptPreview(file)
    expect(preview.truncated).toBe(false)
    expect(preview.messages).toHaveLength(2)
    expect(preview.messages[0]).toEqual({ role: 'user', text: '첫 메시지', timestamp: undefined })
    expect(preview.messages[1]).toEqual({ role: 'assistant', text: '두 번째 메시지', timestamp: undefined })
  })
})

describe('parseTranscriptForResume', () => {
  it('한 번의 읽기로 제목·요청·손댄 파일·꼬리를 모두 뽑는다', async () => {
    const file = await write('all.jsonl', [
      line({ type: 'ai-title', aiTitle: 'fix-flaky-test', sessionId: 's1' }),
      line({ type: 'user', message: { role: 'user', content: '첫 요청' } }),
      line({
        type: 'file-history-snapshot',
        snapshot: { trackedFileBackups: { 'src\\a.ts': { version: 1 } } }
      }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '응답' }] } }),
      line({ type: 'user', message: { role: 'user', content: '두 번째 요청' } }),
      line({
        type: 'file-history-snapshot',
        snapshot: { trackedFileBackups: { 'src\\a.ts': { version: 1 }, 'src\\b.ts': { version: 1 } } }
      })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.title).toBe('fix-flaky-test')
    expect(material.requests).toEqual(['첫 요청', '두 번째 요청'])
    // 가장 최근 file-history-snapshot 만 남고, 경로는 슬래시로 정규화된다
    expect(material.editedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(material.tail.map((m) => m.text)).toEqual(['첫 요청', '응답', '두 번째 요청'])
  })

  // 제목 레코드는 이름이 버전마다 다르다 — 현행 Claude Code 는 `ai-title`, 구버전은 `summary` 다.
  // 이 앱은 구버전 CLI 를 쓰는 사용자에게도 나가므로 둘 다 받아야 하고, 한쪽만 받으면 그 사용자는
  // 제목 줄을 영구히 못 받은 채 그 사실이 조용히 지나간다.
  it('구버전의 summary 레코드도 제목으로 읽는다', async () => {
    const file = await write('old-title.jsonl', [
      line({ type: 'summary', summary: '옛 형식 제목' }),
      line({ type: 'user', message: { role: 'user', content: '요청' } })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.title).toBe('옛 형식 제목')
  })

  it('ai-title 레코드가 없으면 title 은 null 이다 — 그 레코드에 의존하지 않는다', async () => {
    const file = await write('no-title.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '요청' } })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.title).toBeNull()
    expect(material.requests).toEqual(['요청'])
  })

  it('file-history-snapshot 이 한 번도 없으면 editedFiles 는 빈 배열이다', async () => {
    const file = await write('no-snapshot.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '요청' } })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.editedFiles).toEqual([])
  })

  it('기계가 남긴 user 줄은 요청에도 꼬리에도 들어가지 않는다', async () => {
    const file = await write('machine.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '<bash-input>ls -la</bash-input>' } }),
      line({ type: 'user', message: { role: 'user', content: '진짜 요청' } })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.requests).toEqual(['진짜 요청'])
    expect(material.tail.map((m) => m.text)).toEqual(['진짜 요청'])
  })

  // 접두어 목록으로는 못 잡는 부류다 — 스킬 본문은 아무 표지 없이 시작하고, 그 길이가 브리핑
  // 예산을 통째로 먹는다(실측은 isMetaUserRecord 의 JSDoc).
  it('isMeta 레코드는 요청에도 꼬리에도 들어가지 않는다', async () => {
    const file = await write('meta.jsonl', [
      line({ type: 'user', message: { role: 'user', content: '진짜 요청' } }),
      line({
        type: 'user',
        isMeta: true,
        turnCompanion: true,
        sourceToolUseID: 'toolu_01ABC',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: C:/skills/artifact-design' }]
        }
      }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: '[Image: original 3840x2088]' } })
    ])
    const material = await parseTranscriptForResume(file)
    expect(material.requests).toEqual(['진짜 요청'])
    expect(material.tail.map((m) => m.text)).toEqual(['진짜 요청'])
  })

  // Task 6 (Phase 2c) — 실측(2026-08-28, 이 컴퓨터의 실제 대화 파일들): tool_use 이름 Bash 는
  // input.command 를 담고, 짝이 되는 tool_result 는 tool_use_id·is_error·content 를 담는다. 같은
  // 단일 패스에 얹는다(기존 주석이 적어 둔 대로 파일을 다시 훑지 않는다).
  describe('lastCommand — 마지막 Bash 호출과 그 결과(LAST VALIDATION 재료)', () => {
    const bashUse = (id: string, command: string) =>
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
      })
    const bashResult = (id: string, content: string, isError: boolean) =>
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]
        }
      })

    // 리뷰가 잡았다: 슬롯 하나로 추적하던 동안 한 턴이 Bash 를 둘 내보내면 뒤 id 가 앞 id 를
    // 덮어써서, 먼저 시작된 호출의 결과가 도착해도 짝을 못 찾고 조용히 버려졌다. 독립적인 호출은
    // 한 번에 묶어 보내는 것이 권장되므로 드문 모양이 아니다.
    it('한 턴이 Bash 를 둘 내보내고 결과가 역순으로 와도 짝을 맞춘다', async () => {
      const twoUses = line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'git status' } },
            { type: 'tool_use', id: 'p2', name: 'Bash', input: { command: 'npm test' } }
          ]
        }
      })
      const file = await write('cmd-parallel.jsonl', [
        twoUses,
        bashResult('p1', 'clean', false) // 먼저 시작된 쪽의 결과가 먼저 도착한다
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toEqual({ command: 'git status', failed: false, excerpt: 'clean' })
    })

    it('결과가 둘 다 오면 나중에 도착한 쪽이 마지막이다', async () => {
      const twoUses = line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'q1', name: 'Bash', input: { command: 'git status' } },
            { type: 'tool_use', id: 'q2', name: 'Bash', input: { command: 'npm test' } }
          ]
        }
      })
      const file = await write('cmd-parallel2.jsonl', [
        twoUses,
        bashResult('q1', 'clean', false),
        bashResult('q2', '2 tests failed', true)
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand?.command).toBe('npm test')
      expect(material.lastCommand?.failed).toBe(true)
    })

    it('완료된 Bash 호출의 명령·실패 여부·결과를 뽑는다', async () => {
      const file = await write('cmd-ok.jsonl', [bashUse('t1', 'npm test'), bashResult('t1', '2 tests failed', true)])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toEqual({ command: 'npm test', failed: true, excerpt: '2 tests failed' })
    })

    it('is_error 가 false 면 failed 도 false 다 — 종료 코드는 애초에 없다', async () => {
      const file = await write('cmd-success.jsonl', [
        bashUse('t1', 'npm run build'),
        bashResult('t1', 'build succeeded', false)
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand?.failed).toBe(false)
    })

    it('여러 번 실행되면 시간순으로 가장 나중에 완료된 것만 남는다', async () => {
      const file = await write('cmd-many.jsonl', [
        bashUse('t1', 'npm test'),
        bashResult('t1', 'first result', true),
        bashUse('t2', 'npm run lint'),
        bashResult('t2', 'lint clean', false)
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toEqual({ command: 'npm run lint', failed: false, excerpt: 'lint clean' })
    })

    it('마지막 Bash 호출이 아직 결과를 못 받았으면(세션이 그 도중 끊겼으면) 그 이전의 완료된 호출이 남는다', async () => {
      const file = await write('cmd-pending.jsonl', [
        bashUse('t1', 'npm test'),
        bashResult('t1', 'passed', false),
        bashUse('t2', 'npm run deploy') // 결과 없이 파일이 끝난다
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toEqual({ command: 'npm test', failed: false, excerpt: 'passed' })
    })

    it('Bash 호출이 한 번도 없으면 null 이다', async () => {
      const file = await write('cmd-none.jsonl', [
        line({ type: 'user', message: { role: 'user', content: '평범한 요청' } })
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toBeNull()
    })

    it('Bash 가 아닌 다른 도구(Read)는 lastCommand 에 들어가지 않는다', async () => {
      const file = await write('cmd-other-tool.jsonl', [
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }]
          }
        }),
        line({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file contents' }] }
        })
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toBeNull()
    })

    it('tool_result.content 가 배열(text 블록)이어도 방어적으로 읽는다', async () => {
      const file = await write('cmd-array-content.jsonl', [
        bashUse('t1', 'npm test'),
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false }
            ]
          }
        })
      ])
      const material = await parseTranscriptForResume(file)
      expect(material.lastCommand).toEqual({ command: 'npm test', failed: false, excerpt: 'ok' })
    })
  })
})
