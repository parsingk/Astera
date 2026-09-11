import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { reduceCodexRollout } from './codexConversation'
import type { ConvPart, ConvTurn, ToolPart } from './convTypes'

const fixture = (): string[] =>
  readFileSync(join(__dirname, 'fixtures/codex-rollout.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)

const toolParts = (turn: ConvTurn): ToolPart[] =>
  turn.parts.filter((p): p is ToolPart => p.kind === 'tool')

const textOf = (turn: ConvTurn): string =>
  turn.parts
    .filter((p): p is Extract<ConvPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('')

describe('reduceCodexRollout — a real rollout shape', () => {
  it('groups into user / assistant / user', () => {
    expect(reduceCodexRollout(fixture()).map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
  })

  // The ten-to-one ratio measured across 60 files: an assistant turn is a run of records, and drawing
  // one bubble per record would put five of them where the reader expects one.
  it('folds the whole assistant run into one turn', () => {
    const [, assistant] = reduceCodexRollout(fixture())
    expect(textOf(assistant)).toBe('먼저 빌드 로그를 보겠습니다.타입이 안 맞습니다. 고치겠습니다.고쳤습니다. 빌드가 지나갑니다.')
  })

  it('keeps what the person actually typed and drops what the CLI injected', () => {
    const turns = reduceCodexRollout(fixture())
    expect(textOf(turns[0])).toBe('빌드가 왜 깨지는지 봐줘')
    expect(turns.map(textOf).join('')).not.toContain('<environment_context>')
    expect(turns.map(textOf).join('')).not.toContain('Sandbox notes')
  })

  it('pairs every call with its result, by call_id', () => {
    const [, assistant] = reduceCodexRollout(fixture())
    expect(toolParts(assistant).map((p) => `${p.name}:${p.target}`)).toEqual([
      'shell_command:npm run build',
      'apply_patch:src/a.ts',
      'web_search:TS2345 meaning'
    ])
  })

  // codex says a command failed inside the output text, not in a field of its own. A row that reads
  // this wrong is pixel-identical to one that reads it right, which is why it is asserted here.
  it('reads failure out of the exit code, and success out of a patch that applied', () => {
    const [, assistant] = reduceCodexRollout(fixture())
    const [shell, patch, search] = toolParts(assistant)
    expect(shell.outcome).toEqual({ ok: false, detail: 'exit 1' })
    expect(patch.outcome).toEqual({ ok: true, detail: '' })
    expect(search.outcome).toEqual({ ok: true, detail: '' })
  })

  it('drops reasoning, which carries nothing a reader could see', () => {
    const turns = reduceCodexRollout(fixture())
    expect(JSON.stringify(turns)).not.toContain('encrypted_content')
    expect(JSON.stringify(turns)).not.toContain('gAAAAA')
  })
})

describe('reduceCodexRollout — what a window cuts through', () => {
  const call = (callId: string): string =>
    JSON.stringify({
      timestamp: '2026-09-11T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', id: 'fc_x', name: 'shell_command', call_id: callId, arguments: '{"command":"ls"}' }
    })
  const output = (callId: string, text: string): string =>
    JSON.stringify({
      timestamp: '2026-09-11T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: callId, output: text }
    })

  it('leaves a call whose result has not arrived unresolved', () => {
    const [turn] = reduceCodexRollout([call('call_1')])
    expect(toolParts(turn)[0].outcome).toBeNull()
  })

  // The live follow carries this map from one read to the next; without it a result that lands a tick
  // later has nothing to attach to and the row stays spinning for ever.
  it('resolves a call from a later read through the carried map', () => {
    const pending = new Map<string, ToolPart>()
    const [turn] = reduceCodexRollout([call('call_1')], pending)
    reduceCodexRollout([output('call_1', 'Exit code: 0')], pending)
    expect(toolParts(turn)[0].outcome).toEqual({ ok: true, detail: '' })
    expect(pending.size).toBe(0)
  })

  it('ignores a result whose call fell outside the window', () => {
    expect(reduceCodexRollout([output('call_gone', 'Exit code: 0')])).toEqual([])
  })

  it('skips a torn line rather than losing the rest of the window', () => {
    const turns = reduceCodexRollout(['{"type":"response_i', ...fixture()])
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
  })
})

// Measured on this machine's own rollouts, and it is what the first cut of this reducer got wrong:
// the preamble is one record carrying two parts, and the person's opening message is a record of its
// own after it. Judging the record by its joined text sees only the first part.
describe('reduceCodexRollout — the preamble codex writes for itself', () => {
  const userRecord = (...texts: string[]): string =>
    JSON.stringify({
      timestamp: '2026-09-11T10:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: texts.map((text) => ({ type: 'input_text', text }))
      }
    })

  it('drops a record whose every part is preamble, however many parts it has', () => {
    const turns = reduceCodexRollout([
      userRecord(
        '# AGENTS.md instructions for D:\\demo\n\n<INSTRUCTIONS>',
        '<environment_context>\n  <cwd>/w</cwd>'
      ),
      userRecord('<recommended_plugins>\nHere is a list'),
      userRecord('빌드 좀 봐줘')
    ])
    expect(turns.map(textOf)).toEqual(['빌드 좀 봐줘'])
  })

  // The other way round is worse than a leak: a message that happens to sit beside a preamble part
  // would vanish, and nothing on screen would say a word had been lost.
  it('keeps a record that has even one part a person wrote', () => {
    const turns = reduceCodexRollout([
      userRecord('<environment_context>\n  <cwd>/w</cwd>', '이어서 해줘')
    ])
    expect(turns.map(textOf)).toEqual(['<environment_context>\n  <cwd>/w</cwd>이어서 해줘'])
  })
})
