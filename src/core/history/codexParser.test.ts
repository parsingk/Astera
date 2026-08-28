import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseCodexMeta, parseCodexTail, parseCodexPreview, parseCodexForResume, ROLLOUT_UUID_RE } from './codexParser'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rollout-'))
})

const metaLine = JSON.stringify({
  timestamp: '2026-07-09T04:31:54.185Z',
  type: 'session_meta',
  payload: {
    session_id: '019f4524-e0ac-7571-a8af-5585504f0d32',
    cwd: 'D:\\proj\\demo',
    originator: 'codex-tui'
  }
})
const user = (text: string): string =>
  JSON.stringify({
    timestamp: '2026-07-09T04:32:04.447Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text }
  })
const agent = (text: string): string =>
  JSON.stringify({
    timestamp: '2026-07-09T04:32:08.937Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: text }
  })
const noise = JSON.stringify({
  timestamp: 't',
  type: 'response_item',
  payload: { type: 'reasoning', id: 'r1' }
})

async function write(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8')
  return p
}

describe('parseCodexMeta', () => {
  it('session_meta에서 sessionId·cwd, 첫 사용자 메시지에서 title을 뽑는다', async () => {
    const p = await write('a.jsonl', [metaLine, noise, user('버그 고쳐줘'), agent('네')])
    expect(await parseCodexMeta(p)).toEqual({
      sessionId: '019f4524-e0ac-7571-a8af-5585504f0d32',
      cwd: 'D:\\proj\\demo',
      title: '버그 고쳐줘'
    })
  })

  it('환경 래퍼(<environment_context> 등)는 title에서 제외한다', async () => {
    const p = await write('b.jsonl', [metaLine, user('<environment_context>...'), user('진짜 질문')])
    expect((await parseCodexMeta(p)).title).toBe('진짜 질문')
  })

  it('깨진 줄·meta 없음은 null 필드로 폴백한다', async () => {
    const p = await write('c.jsonl', ['{broken', noise])
    expect(await parseCodexMeta(p)).toEqual({ sessionId: null, cwd: null, title: null })
  })
})

describe('parseCodexTail', () => {
  it('마지막 의미 메시지가 agent면 awaitingReply=true, 마지막 사용자 제목을 뽑는다', async () => {
    const p = await write('d.jsonl', [
      metaLine,
      user('첫 질문'),
      agent('답'),
      user('두번째 질문'),
      agent('최종 답'),
      noise
    ])
    expect(await parseCodexTail(p)).toEqual({ lastUserTitle: '두번째 질문', awaitingReply: true })
  })

  it('마지막이 user면 awaitingReply=false', async () => {
    const p = await write('e.jsonl', [metaLine, agent('a'), user('마지막 질문')])
    expect(await parseCodexTail(p)).toEqual({ lastUserTitle: '마지막 질문', awaitingReply: false })
  })
})

describe('parseCodexPreview', () => {
  // parser.ts 의 parseTranscriptPreview 와 **같은 규칙**이어야 한다 — 두 provider 의 미리보기가
  // 서로 다른 범위를 보여 주면 같은 화면이 계정에 따라 다르게 읽힌다
  it('턴이 많으면 최근 10 턴만 남기고 truncated=true', async () => {
    const lines: string[] = [metaLine]
    for (let i = 1; i <= 12; i++) {
      lines.push(user(`q${i}`))
      lines.push(agent(`a${i}`))
    }
    const { messages, truncated } = await parseCodexPreview(await write('many.jsonl', lines))
    expect(truncated).toBe(true)
    expect(messages[0].text).toBe('q3')
    expect(messages.at(-1)?.text).toBe('a12')
    expect(messages).toHaveLength(20)
  })

  it('user/agent 메시지만 순서대로 role 매핑하고 래퍼·노이즈는 제외한다', async () => {
    const p = await write('f.jsonl', [metaLine, user('<user_instructions>x'), user('q1'), noise, agent('a1')])
    const { messages, truncated } = await parseCodexPreview(p)
    expect(truncated).toBe(false)
    expect(messages).toEqual([
      { role: 'user', text: 'q1', timestamp: '2026-07-09T04:32:04.447Z' },
      { role: 'assistant', text: 'a1', timestamp: '2026-07-09T04:32:08.937Z' }
    ])
  })
})

// Task 3 (Phase 2c) — 탭 세션용 재개 브리핑 재료의 codex 대응. parser.ts 의
// parseTranscriptForResume 과 같은 자리이지만, codex rollout 에는 claude 의 제목·손댄 파일 레코드가
// 없어 그 둘은 항상 비운다(buildTabResumeText 가 손댄 파일은 git 으로 내려간다).
describe('parseCodexForResume', () => {
  it('요청·꼬리를 시간 순으로 뽑고, wrapper 는 제외하며, 제목·손댄 파일은 늘 비운다', async () => {
    const p = await write('resume-a.jsonl', [
      metaLine,
      user('첫 요청'),
      agent('네 알겠습니다'),
      user('<environment_context>...'), // wrapper — 요청도 꼬리도 아니다
      user('두번째 요청'),
      noise
    ])
    const material = await parseCodexForResume(p)
    expect(material.title).toBeNull() // codex 에는 ai-title/summary 에 해당하는 레코드가 없다
    expect(material.editedFiles).toEqual([]) // codex 에는 file-history-snapshot 에 해당하는 레코드가 없다
    expect(material.requests).toEqual(['첫 요청', '두번째 요청'])
    expect(material.tail).toEqual([
      { role: 'user', text: '첫 요청', timestamp: '2026-07-09T04:32:04.447Z' },
      { role: 'assistant', text: '네 알겠습니다', timestamp: '2026-07-09T04:32:08.937Z' },
      { role: 'user', text: '두번째 요청', timestamp: '2026-07-09T04:32:04.447Z' }
    ])
  })

  it('요청·꼬리 각각 상한(20)을 넘으면 오래된 것부터 버린다', async () => {
    const lines: string[] = [metaLine]
    for (let i = 1; i <= 25; i++) lines.push(user(`q${i}`))
    const material = await parseCodexForResume(await write('resume-b.jsonl', lines))
    expect(material.requests).toHaveLength(20)
    expect(material.requests[0]).toBe('q6')
    expect(material.requests.at(-1)).toBe('q25')
  })
})

describe('ROLLOUT_UUID_RE', () => {
  it('rollout 파일명에서 uuid를 뽑는다', () => {
    const m = 'rollout-2026-07-09T13-31-12-019f4524-e0ac-7571-a8af-5585504f0d32.jsonl'.match(
      ROLLOUT_UUID_RE
    )
    expect(m?.[1]).toBe('019f4524-e0ac-7571-a8af-5585504f0d32')
  })
})
