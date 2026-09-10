import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { reduceTranscript, type ConvPart, type ConvTurn } from './conversation'

const line = (obj: unknown): string => JSON.stringify(obj)

const shapesFixture = (): string[] =>
  readFileSync(join(__dirname, 'fixtures/conversation-shapes.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)

const turnFixture = (): string[] =>
  readFileSync(join(__dirname, 'fixtures/conversation-turn.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)

const toolParts = (turn: ConvTurn): Extract<ConvPart, { kind: 'tool' }>[] =>
  turn.parts.filter((p): p is Extract<ConvPart, { kind: 'tool' }> => p.kind === 'tool')

describe('reduceTranscript — 실제 턴 하나 (conversation-turn.jsonl)', () => {
  it('user / assistant / user 세 턴으로 묶인다', () => {
    const turns = reduceTranscript(turnFixture())
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('중간 assistant 턴은 tool 파트들과 마지막 하나의 text 파트로만 이루어진다 — thinking·fallback 은 없다', () => {
    const [, assistantTurn] = reduceTranscript(turnFixture())
    // 실측: Bash tool_use 10개 뒤에 최종 text 하나. 그 사이의 thinking 블록들은 파트를 만들지 않는다.
    expect(assistantTurn.parts).toHaveLength(11)
    expect(assistantTurn.parts.slice(0, -1).every((p) => p.kind === 'tool')).toBe(true)
    expect(assistantTurn.parts[assistantTurn.parts.length - 1].kind).toBe('text')
    expect(assistantTurn.parts.every((p) => p.kind === 'tool' || p.kind === 'text')).toBe(true)
  })

  it('턴의 id·timestamp는 그 턴을 만든 첫 항목의 것이다', () => {
    const turns = reduceTranscript(turnFixture())
    expect(turns[0]).toMatchObject({
      id: '39d0c83a-9d9a-43d8-b6db-26fdff6d09c9',
      timestamp: '2026-09-03T06:14:55.601Z'
    })
    // 두 번째 턴의 첫 항목은 thinking 블록 하나뿐인 assistant 줄이다 — 파트는 없지만 턴은 거기서 열린다.
    expect(turns[1]).toMatchObject({
      id: 'da126648-b81a-4cd0-a25c-b13a29f96a48',
      timestamp: '2026-09-03T06:15:09.538Z'
    })
    expect(turns[2]).toMatchObject({
      id: 'c8682da0-3f92-4c0c-8c1e-1c695eda4031',
      timestamp: '2026-09-03T06:50:46.666Z'
    })
  })
})

describe('reduceTranscript — 도구별 outcome (conversation-shapes.jsonl)', () => {
  it('Read(텍스트) 는 file.numLines 에서 "N lines" 를 낸다', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const read = parts.find((p) => p.name === 'Read' && p.target.endsWith('.md'))
    expect(read?.outcome).not.toBeNull()
    expect(read?.outcome?.ok).toBe(true)
    expect(read?.outcome?.detail).toMatch(/^\d+ lines$/)
  })

  it('Read(이미지) 는 개수 없이 detail 이 비어 있고 ok 는 true다', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const read = parts.find((p) => p.name === 'Read' && p.target.endsWith('.png'))
    expect(read?.outcome).toEqual({ ok: true, detail: '' })
  })

  it('Grep 은 mode 에 따라 numFiles 또는 numLines 에서 detail 을 낸다 — 이 표본은 content 모드라 matches', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const grep = parts.find((p) => p.name === 'Grep')
    expect(grep?.outcome?.ok).toBe(true)
    expect(grep?.outcome?.detail).toMatch(/^\d+ matches$/)
  })

  it('Edit 은 structuredPatch 의 +/- 라인을 세어 "+N -M" 을 낸다', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const edits = parts.filter((p) => p.name === 'Edit')
    expect(edits.length).toBeGreaterThanOrEqual(2) // 한 훅·여러 훅 두 표본 모두 있다
    for (const edit of edits) {
      expect(edit.outcome?.ok).toBe(true)
      expect(edit.outcome?.detail).toMatch(/^\+\d+ -\d+$/)
    }
  })

  it('Write 는 항상 "new file" 이다 — structuredPatch 가 비어 있어 셀 것이 없다', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const write = parts.find((p) => p.name === 'Write')
    expect(write?.outcome).toEqual({ ok: true, detail: 'new file' })
  })

  it('Bash 성공은 stdout 에서 "N lines" 를 낸다', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const bash = parts.find((p) => p.name === 'Bash' && p.outcome?.ok === true)
    expect(bash?.outcome?.detail).toMatch(/^\d+ lines$/)
  })

  it('실패한 호출은 ok=false 이고, toolUseResult 가 문자열이어도 죽지 않는다', () => {
    let turns: ConvTurn[] = []
    expect(() => {
      turns = reduceTranscript(shapesFixture())
    }).not.toThrow()
    const failed = turns.flatMap(toolParts).find((p) => p.name === 'Bash' && p.outcome?.ok === false)
    expect(failed?.outcome).toEqual({ ok: false, detail: '' })
  })

  it('알 수 없는 도구 이름은 그대로 통과한다 — target 은 input 의 첫 문자열 값, detail 은 빈 문자열', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com', timeout: 30 } }]
        }
      }),
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        toolUseResult: { someField: 1 }
      })
    ])
    const tool = toolParts(turns[0])[0]
    expect(tool.name).toBe('WebFetch')
    expect(tool.target).toBe('https://example.com')
    expect(tool.outcome).toEqual({ ok: true, detail: '' })
  })
})

describe('reduceTranscript — 합성 케이스', () => {
  it('배치로 나간 호출은 위치가 아니라 tool_use_id 로 짝짓는다 (결과가 뒤바뀐 순서로 와도)', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }] }
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/b.ts' } }] }
      }),
      // 결과는 t2 -> t1 순서로, 호출 순서(t1 -> t2)와 반대로 온다
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
        toolUseResult: {
          type: 'create',
          filePath: '/b.ts',
          content: 'x',
          structuredPatch: [],
          originalFile: null,
          userModified: false
        }
      }),
      line({
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        toolUseResult: {
          type: 'text',
          file: { filePath: '/a.ts', content: 'x', numLines: 5, startLine: 1, totalLines: 5 }
        }
      })
    ])
    expect(turns).toHaveLength(1) // 연속된 assistant 두 줄이 하나의 턴으로 묶인다
    const parts = toolParts(turns[0])
    const read = parts.find((p) => p.id === 't1')
    const write = parts.find((p) => p.id === 't2')
    expect(read?.outcome).toEqual({ ok: true, detail: '5 lines' })
    expect(write?.outcome).toEqual({ ok: true, detail: 'new file' })
  })

  it('결과가 아직 안 온 호출은 outcome 이 null 로 남는다', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
      })
    ])
    const tool = turns[0].parts[0]
    expect(tool.kind).toBe('tool')
    expect((tool as Extract<ConvPart, { kind: 'tool' }>).outcome).toBeNull()
  })

  it('창 밖에서 온(짝 없는) tool_result 는 턴도 파트도 만들지 않는다', () => {
    const turns = reduceTranscript([
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] }
      })
    ])
    expect(turns).toEqual([])
  })

  it('meta user 기록과 슬래시 커맨드류는 턴을 만들지 않고, 실제 사람 메시지만 턴이 된다', () => {
    const turns = reduceTranscript([
      line({ type: 'user', uuid: 'u0', isMeta: true, message: { content: '스킬 본문이 통째로 실린 자리' } }),
      line({ type: 'user', uuid: 'u1', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', uuid: 'u2', message: { content: 'why is store.load closing them' } })
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].parts).toEqual([{ kind: 'text', text: 'why is store.load closing them' }])
  })

  it('깨진 줄은 건너뛰고, 앞뒤 줄은 그대로 살아남는다', () => {
    const turns = reduceTranscript([
      line({ type: 'user', uuid: 'u1', message: { content: 'one' } }),
      '{ this is not json',
      line({ type: 'user', uuid: 'u2', message: { content: 'two' } })
    ])
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u2'])
  })

  it('방어적 케이스: 한 메시지 안에 text 와 tool_use 가 섞여도 등장 순서를 지킨다 (실데이터에는 없는 모양)', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.ts' } },
            { type: 'text', text: 'second' }
          ]
        }
      })
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].parts.map((p) => p.kind)).toEqual(['text', 'tool', 'text'])
  })
})
