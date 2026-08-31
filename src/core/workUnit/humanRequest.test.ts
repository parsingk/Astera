import { describe, it, expect } from 'vitest'
import { hasWriteEvidence } from './humanRequest'

// 관찰된 변경은 그 프로젝트의 열린 Unit 전부에 들어간다 — git 은 무엇이 바뀌었는지만 말하고 누가
// 바꿨는지는 모른다. 세션별로 갈라지는 증거는 그 세션의 기록뿐이다.
describe('hasWriteEvidence', () => {
  const claudeTool = (name: string): Record<string, unknown> => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] }
  })
  const codexItem = (kind: string): Record<string, unknown> => ({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: kind, id: 'i' } }
  })

  it.each(['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task'])(
    'claude 의 %s 는 증거다',
    (name) => {
      expect(hasWriteEvidence(claudeTool(name))).toBe(true)
    }
  )

  it.each(['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite'])('claude 의 %s 는 증거가 아니다', (name) => {
    expect(hasWriteEvidence(claudeTool(name))).toBe(false)
  })

  // 이름만으로 쓰기인지 알 수 없다 — 모를 때 세지 않는 것이 이 목록의 기본값이다
  it('MCP 도구는 증거로 세지 않는다', () => {
    expect(hasWriteEvidence(claudeTool('mcp__serena__create_text_file'))).toBe(false)
  })

  it.each(['FileChange', 'CommandExecution'])('codex 의 %s 는 증거다', (kind) => {
    expect(hasWriteEvidence(codexItem(kind))).toBe(true)
  })

  it('codex 의 다른 항목은 증거가 아니다', () => {
    expect(hasWriteEvidence(codexItem('AgentMessage'))).toBe(false)
    expect(hasWriteEvidence(codexItem('Reasoning'))).toBe(false)
  })

  it('사람의 요청 자체는 증거가 아니다 — 질문만 한 세션이 걸러지는 자리다', () => {
    expect(
      hasWriteEvidence({ type: 'user', promptSource: 'typed', message: { role: 'user', content: '설명해줘' } })
    ).toBe(false)
  })

  it('모양이 깨진 줄에도 던지지 않는다', () => {
    expect(hasWriteEvidence({})).toBe(false)
    expect(hasWriteEvidence({ type: 'assistant' })).toBe(false)
    expect(hasWriteEvidence({ type: 'assistant', message: { content: 'not an array' } })).toBe(false)
    expect(hasWriteEvidence({ type: 'event_msg', payload: null })).toBe(false)
    expect(hasWriteEvidence({ type: 'event_msg', payload: { type: 'item_completed' } })).toBe(false)
  })
})
