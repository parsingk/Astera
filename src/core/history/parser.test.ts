import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTranscriptMeta, parseTranscriptPreview, parseTranscriptTail } from './parser'

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

describe('parseTranscriptPreview', () => {
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
