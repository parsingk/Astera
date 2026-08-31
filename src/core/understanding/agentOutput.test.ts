import { describe, it, expect } from 'vitest'
import { extractJson, readClaudeOutput, readCodexOutput } from './agentOutput'

describe('readClaudeOutput — -p --output-format json', () => {
  it('result 를 꺼낸다', () => {
    const r = readClaudeOutput(JSON.stringify({ is_error: false, result: 'hello', total_cost_usd: 0.4 }))
    expect(r).toEqual({ ok: true, text: 'hello' })
  })

  it('is_error 면 그 result 는 답이 아니라 사유다', () => {
    const r = readClaudeOutput(JSON.stringify({ is_error: true, result: '한도에 걸렸습니다' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('한도에 걸렸습니다')
  })

  it('JSON 이 아니거나 빈 답이면 사유를 남긴다', () => {
    expect(readClaudeOutput('그냥 글').ok).toBe(false)
    expect(readClaudeOutput(JSON.stringify({ is_error: false, result: '  ' })).ok).toBe(false)
    expect(readClaudeOutput('[]').ok).toBe(false)
  })
})

describe('readCodexOutput — exec --json', () => {
  // 실측 형식 그대로
  const stream = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}'
  ].join('\n')

  it('agent_message 의 text 를 꺼낸다', () => {
    expect(readCodexOutput(stream)).toEqual({ ok: true, text: '{"ok":true}' })
  })

  it('여러 번 말하면 마지막이 결론이다', () => {
    const two =
      '{"type":"item.completed","item":{"type":"agent_message","text":"먼저"}}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"나중"}}'
    expect(readCodexOutput(two)).toEqual({ ok: true, text: '나중' })
  })

  // codex 는 훅 로그 같은 비JSON 줄을 섞어 낸다(실측)
  it('비JSON 줄과 다른 이벤트는 넘긴다', () => {
    const noisy = 'hook: UserPromptSubmit\n' + stream + '\ntokens used\n8,852'
    expect(readCodexOutput(noisy)).toEqual({ ok: true, text: '{"ok":true}' })
  })

  it('답이 없으면 사유를 남긴다', () => {
    expect(readCodexOutput('{"type":"turn.completed"}').ok).toBe(false)
    expect(readCodexOutput('').ok).toBe(false)
  })
})

describe('extractJson — 계약이 요구한 JSON 을 본문에서 꺼낸다', () => {
  it('그냥 JSON 이면 그대로', () => {
    const r = extractJson('{"a":1}')
    expect(r.ok && r.value).toEqual({ a: 1 })
  })

  // 계약이 "펜스 없이"라고 해도 모델은 종종 두른다. 그것으로 생성 전체가 실패하는 것은 아깝다
  it('```json 펜스를 벗긴다', () => {
    const r = extractJson('```json\n{"a":1}\n```')
    expect(r.ok && r.value).toEqual({ a: 1 })
    const r2 = extractJson('```\n{"a":1}\n```')
    expect(r2.ok && r2.value).toEqual({ a: 1 })
  })

  it('앞뒤에 한 줄씩 붙어도 꺼낸다', () => {
    const r = extractJson('여기 있습니다:\n{"a":1}\n확인해 주세요.')
    expect(r.ok && r.value).toEqual({ a: 1 })
  })

  it('객체가 아니면 실패다 — 배열이나 숫자를 설명으로 받지 않는다', () => {
    expect(extractJson('[1,2]').ok).toBe(false)
    expect(extractJson('42').ok).toBe(false)
  })

  it('JSON 이 아예 없으면 사유를 남긴다 — 그 이상 추측하지 않는다', () => {
    const r = extractJson('설명을 만들 수 없었습니다.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('JSON')
  })
})
