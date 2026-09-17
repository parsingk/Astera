import { describe, it, expect } from 'vitest'
import { configuredModelOf, parseClaudeModels, parseCodexModels } from './parse'

// 실측 응답을 줄인 것 (2026-08-30, 이 컴퓨터)
const claudeRaw = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', supportsEffort: false }
]

const codexRaw = [
  {
    id: 'srv-1',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    // **객체 배열이다** — 실측 원문 그대로. 문자열 배열로 읽으면 조용히 비어서 강도 선택이 사라진다
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
      { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth' },
      { reasoningEffort: 'high', description: 'Greater reasoning depth' },
      { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth' },
      { reasoningEffort: 'max', description: 'Maximum reasoning depth' },
      { reasoningEffort: 'ultra', description: 'Maximum reasoning with delegation' }
    ],
    defaultReasoningEffort: 'low',
    hidden: false,
    isDefault: true
  },
  { id: 'srv-2', model: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', hidden: false },
  { id: 'srv-3', model: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true }
]

describe('parseClaudeModels', () => {
  it('실측 응답을 ModelDescriptor 로 옮긴다', () => {
    const m = parseClaudeModels(claudeRaw)
    expect(m).toHaveLength(3)
    expect(m[0]).toEqual({
      provider: 'claude',
      id: 'default',
      name: 'Default (recommended)',
      description: 'Opus 5',
      isDefault: true,
      resolvedModel: 'claude-opus-5[1m]',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
    })
  })

  // 첫 턴 전에는 CLI 가 현재 모델을 말해 주지 않는다(system/init 은 턴이 시작될 때 온다). 목록의
  // default 줄이 가리키는 정식 이름이 그때 보여 줄 수 있는 유일한 값이라 버리지 않고 남긴다.
  it("default 줄의 resolvedModel 을 남긴다 — 첫 턴 전에 보여 줄 기본 모델", () => {
    const m = parseClaudeModels(claudeRaw)
    expect(m.find((x) => x.isDefault)?.resolvedModel).toBe('claude-opus-5[1m]')
    expect(m.find((x) => x.id === 'haiku')?.resolvedModel).toBe('claude-haiku-4-5-20251001')
  })

  // --model 이 받는 값은 value 다 — resolvedModel 은 그것이 가리키는 정식 이름이라 다르다
  it('id 는 value 다 — resolvedModel 이 아니다', () => {
    expect(parseClaudeModels(claudeRaw).map((x) => x.id)).toEqual(['default', 'sonnet', 'haiku'])
  })

  it("value 가 'default' 인 줄이 이 계정의 기본이다", () => {
    const m = parseClaudeModels(claudeRaw)
    expect(m.filter((x) => x.isDefault).map((x) => x.id)).toEqual(['default'])
  })

  it('강도를 안 받는 모델은 effortLevels 가 없다', () => {
    expect(parseClaudeModels(claudeRaw)[2].effortLevels).toBeUndefined()
  })

  it('모양이 어긋난 항목만 건너뛴다 — 목록 전체를 버리지 않는다', () => {
    const m = parseClaudeModels([{ value: 'sonnet' }, null, 'x', { displayName: 'value 가 없다' }])
    expect(m.map((x) => x.id)).toEqual(['sonnet'])
    expect(m[0].name).toBe('sonnet') // displayName 이 없으면 id 로 저하
  })

  it('배열이 아니면 빈 목록이다 — 던지지 않는다', () => {
    expect(parseClaudeModels(undefined)).toEqual([])
    expect(parseClaudeModels({ models: [] })).toEqual([])
  })
})

describe('parseCodexModels', () => {
  it('실측 응답을 ModelDescriptor 로 옮긴다', () => {
    const m = parseCodexModels(codexRaw)
    expect(m).toHaveLength(2) // hidden 은 빠졌다
    expect(m[0]).toEqual({
      provider: 'codex',
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      description: 'Latest frontier agentic coding model.',
      isDefault: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'low'
    })
  })

  // -m 에 넘길 값은 model 이다. id 는 서버 식별자라 갈릴 수 있고, 갈리면 CLI 가 모르는 이름을 받는다
  it('id 는 model 필드다 — 서버의 id 가 아니다', () => {
    expect(parseCodexModels(codexRaw).map((x) => x.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini'])
  })

  it('model 이 없으면 id 로 저하한다', () => {
    expect(parseCodexModels([{ id: 'only-id' }])[0].id).toBe('only-id')
  })

  it('hidden 은 거른다 — 사용자가 고를 대상이 아니다', () => {
    expect(parseCodexModels(codexRaw).some((x) => x.id === 'gpt-reserve')).toBe(false)
  })

  it('배열이 아니거나 모양이 어긋나면 빈 목록·건너뛰기다', () => {
    expect(parseCodexModels(null)).toEqual([])
    expect(parseCodexModels([null, {}, 'x'])).toEqual([])
  })

  // 실측에서 잡은 것: 이 필드는 문자열 배열이 아니라 객체 배열이다. 문자열만 받으면 조용히
  // 비어서 강도 선택이 화면에서 사라진다 — 오류 없이 기능만 없어지는 종류다
  it('강도 목록이 객체 배열이어도 이름을 꺼낸다', () => {
    const m = parseCodexModels([
      { model: 'x', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }
    ])
    expect(m[0].effortLevels).toEqual(['low', 'high'])
  })

  it('문자열 배열로 와도 읽는다 — 형식이 바뀌어도 한쪽은 산다', () => {
    expect(parseCodexModels([{ model: 'x', supportedReasoningEfforts: ['low'] }])[0].effortLevels).toEqual(['low'])
  })

  it('모양을 모르는 원소만 버린다', () => {
    const m = parseCodexModels([{ model: 'x', supportedReasoningEfforts: [{ nope: 1 }, 'high'] }])
    expect(m[0].effortLevels).toEqual(['high'])
  })
})

describe('configuredModelOf', () => {
  // Claude's own settings name a model, and a session started without `--model` runs that one. Measured
  // on this machine (2026-09-17): an account whose settings.json carried
  // `"model": "claude-fable-5-1[1m]"` opened `system/init` on `claude-fable-5-1`, while an account with
  // no such key opened on `claude-opus-5[1m]` -- same CLI, same arguments, same folder. Nothing in the
  // handshake reports this: the model list has no "this is the one in use" marker and the initialize
  // response carries no model at all, so reading it is the only way to name the model before the first
  // turn, and the first turn is when `system/init` finally says it.
  it('takes the first source that names one', () => {
    expect(configuredModelOf([{}, { model: 'claude-fable-5-1[1m]' }, { model: 'sonnet' }]))
      .toBe('claude-fable-5-1[1m]')
  })

  // Claude reads local over project over user, so callers hand them over in that order and the first
  // hit wins. A source that is missing is passed as null rather than skipped, so the order is the
  // caller's and not an accident of which files happened to exist.
  it('lets a nearer source win, and ignores one that is not there', () => {
    expect(configuredModelOf([null, { model: 'sonnet' }, { model: 'opus' }])).toBe('sonnet')
  })

  it('is null when nothing names one, and for values that are not a model name', () => {
    expect(configuredModelOf([])).toBeNull()
    expect(configuredModelOf([{}, null, { permissions: {} }])).toBeNull()
    expect(configuredModelOf([{ model: '' }, { model: 42 }, { model: null }])).toBeNull()
  })
})
