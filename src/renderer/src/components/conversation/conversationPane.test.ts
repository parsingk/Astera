import { describe, it, expect } from 'vitest'
import type { AppendMessage } from '@assistant-ui/react'
import {
  toThreadMessages,
  mergeTurns,
  keepWhatIsKnown,
  nextTurnsFor,
  shouldResetPaging,
  nextAttentionFor,
  composerTextOf,
  shouldCloseStaleOpen,
  ptyWritesFor,
  isSlashCommand,
  modelLineOf
} from './ConversationPane'
import type { ConvTurn } from '../../../../core/history/convTypes'

// Shared by mergeTurns's and nextTurnsFor's describe blocks below — both need "some existing turns",
// and nextTurnsFor's own tests need mergeTurns's actual behavior underneath them, not a lookalike.
const turnA: ConvTurn = { id: 'a', role: 'user', parts: [{ kind: 'text', text: 'a' }] }
const turnB: ConvTurn = { id: 'b', role: 'assistant', parts: [{ kind: 'text', text: 'b' }] }
const turnC: ConvTurn = { id: 'c', role: 'user', parts: [{ kind: 'text', text: 'c' }] }

describe('toThreadMessages', () => {
  it('maps a text part, a tool part with an outcome, and a tool part without one', () => {
    const turn: ConvTurn = {
      id: 'turn-1',
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'reading the file' },
        {
          kind: 'tool',
          id: 'tool-1',
          name: 'Read',
          target: 'src/a.ts',
          outcome: { ok: true, detail: '10 lines' }
        },
        { kind: 'tool', id: 'tool-2', name: 'Bash', target: 'npm test', outcome: null }
      ]
    }

    const [message] = toThreadMessages([turn])

    expect(message.content).toEqual([
      { type: 'text', text: 'reading the file' },
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        args: { target: 'src/a.ts' },
        result: { ok: true, detail: '10 lines' }
      },
      {
        type: 'tool-call',
        toolCallId: 'tool-2',
        toolName: 'Bash',
        args: { target: 'npm test' },
        result: undefined
      }
    ])
    // Named directly: ToolRow (./ToolRow.tsx) reads `result === undefined` as "still running". A
    // mapping that let `null` pass through unchanged would fail this line while still passing a
    // looser "is falsy" check.
    const runningPart = message.content[2] as { result: unknown }
    expect(runningPart.result).toBe(undefined)
    expect(runningPart.result).not.toBeNull()
  })

  it('keeps a text part and a tool part in the order the turn held them', () => {
    const turn: ConvTurn = {
      id: 'turn-2',
      role: 'assistant',
      parts: [
        { kind: 'tool', id: 'tool-1', name: 'Grep', target: 'TODO', outcome: { ok: true, detail: '3 files' } },
        { kind: 'text', text: 'found three matches' }
      ]
    }

    const [message] = toThreadMessages([turn])

    // `ThreadMessageLike.content` is typed as `string | readonly (...)[]` (the string form is a
    // shortcut this mapping never produces) — cast to the array form to read `.type` off each part.
    const content = message.content as readonly { type: string }[]
    expect(content.map((part) => part.type)).toEqual(['tool-call', 'text'])
  })
})

describe('mergeTurns', () => {
  it('appends a genuinely new turn', () => {
    const result = mergeTurns([turnA, turnB], [turnC], false)
    expect(result).toEqual([turnA, turnB, turnC])
  })

  it('replaces a re-emitted turn in place, not at the end', () => {
    // Three turns, then the first comes back with its tool call resolved — main's own scenario
    // (core/types.ts's doc on conversation:append): a result landing in a later read re-emits the
    // whole turn that owns it, with the same id.
    const resolvedA: ConvTurn = {
      id: 'a',
      role: 'user',
      parts: [
        { kind: 'tool', id: 'tool-1', name: 'Bash', target: 'npm test', outcome: { ok: true, detail: '' } }
      ]
    }

    const result = mergeTurns([turnA, turnB, turnC], [resolvedA], false)

    // Identity and order both — a bug that appends the replacement instead of replacing in place
    // would still produce a three-element array (turnB, turnC, resolvedA), so length alone proves
    // nothing here. The first element has to be resolvedA, and the array has to be the same length
    // it started at.
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual(resolvedA)
    expect(result[1]).toEqual(turnB)
    expect(result[2]).toEqual(turnC)
  })

  it('discards everything held when restarted is true', () => {
    const result = mergeTurns([turnA, turnB], [turnC], true)
    // Not [turnA, turnB, turnC] — restarted means incoming is the whole conversation from here, not
    // an addition to what was drawn before.
    expect(result).toEqual([turnC])
  })
})

describe('nextTurnsFor', () => {
  // Two panes can be open on two different sessions at once (conversation:append fires app-wide,
  // per session, regardless of which pane is showing it) — this is the check that stands between
  // them and drawing each other's turns.
  it('merges when the event belongs to this pane\'s own session', () => {
    const result = nextTurnsFor('s1', [turnA], { sessionId: 's1', turns: [turnB], restarted: false })
    expect(result).toEqual([turnA, turnB])
  })

  // Reference identity, not just content — a filter that let a foreign event through would still
  // produce an array that *looks* like [turnA] if the event's own turns happened to be empty or
  // duplicate it, so this pins that `prev` itself comes back untouched, not a copy of it.
  // The replace-by-id guarantee lives in mergeTurns, and this is the only test that reaches it
  // through nextTurnsFor's own interface. Without it, an edit that stops delegating and appends
  // instead passes every other test here: the neighbouring merge test adds a NEW id, which looks
  // identical whether it was appended or merged. A resolved tool call would then draw a second
  // copy of its turn below the pending one instead of filling it in.
  it('replaces a turn of the same id in place, not at the end', () => {
    const resolved = { ...turnA, parts: [{ kind: 'text' as const, text: 'resolved' }] }
    const result = nextTurnsFor('s1', [turnA, turnB], {
      sessionId: 's1',
      turns: [resolved],
      restarted: false
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(resolved)
    expect(result[1]).toBe(turnB)
  })

  it('leaves turns exactly as they were — same reference — for a foreign session', () => {
    const prev = [turnA]
    const result = nextTurnsFor('s1', prev, { sessionId: 's2', turns: [turnB], restarted: false })
    expect(result).toBe(prev)
  })
})

describe('shouldResetPaging', () => {
  it('true for this pane\'s own restart', () => {
    expect(shouldResetPaging('s1', { sessionId: 's1', restarted: true })).toBe(true)
  })

  it('false for this pane\'s own append that is not a restart', () => {
    expect(shouldResetPaging('s1', { sessionId: 's1', restarted: false })).toBe(false)
  })

  // The same blind spot nextTurnsFor's foreign-session test guards: a restart on a session this
  // pane is not showing must not reset a paging window that is still perfectly valid.
  it('false for a restart reported on a foreign session', () => {
    expect(shouldResetPaging('s1', { sessionId: 's2', restarted: true })).toBe(false)
  })
})

describe('nextAttentionFor', () => {
  it('reads the value for this pane\'s own session', () => {
    expect(nextAttentionFor('s1', { sessionId: 's1', value: 'waiting' })).toBe('waiting')
  })

  // Same shape as nextTurnsFor's and shouldResetPaging's own foreign-session case: this event also
  // fires for every session app-wide, and a firing for a session this pane is not showing must be a
  // complete no-op — undefined is the caller's cue to leave attention exactly as it is.
  it('is undefined for a foreign session', () => {
    expect(nextAttentionFor('s1', { sessionId: 's2', value: 'waiting' })).toBeUndefined()
  })
})

describe('composerTextOf', () => {
  it('joins only the text parts and ignores the rest', () => {
    const parts = [
      { type: 'text', text: 'hello ' },
      // A non-text part that happens to carry a `.text` field of its own — no real part type does
      // (ImageMessagePart has no `.text`), but `Array.prototype.join` renders a genuinely *missing*
      // `.text` as `''` regardless of whether the filter ran, so a fixture without one cannot tell
      // "filtered before mapping" apart from "not filtered, relying on undefined-to-empty-string
      // coercion". This sentinel value would leak into the result if the filter were ever removed.
      { type: 'image', image: 'data:image/png;base64,abc', text: 'SHOULD NOT APPEAR' },
      { type: 'text', text: 'world' }
    ] as unknown as AppendMessage['content']

    expect(composerTextOf(parts)).toBe('hello world')
  })
})

// The rule this guards is the one the hand check caught: an `open` that resolves after its own run
// ended must not close a session a newer run has since opened. Unconditional closing looks harmless
// in the code and leaves every other test here green, while the pane it breaks still draws its turns
// and simply stops updating.
describe('shouldCloseStaleOpen', () => {
  it('does not close a session the pane is still mounted for', () => {
    expect(shouldCloseStaleOpen('s1', 's1')).toBe(false)
  })

  it('closes when the pane has unmounted', () => {
    expect(shouldCloseStaleOpen(null, 's1')).toBe(true)
  })

  it('closes the old session when the pane has moved to another one', () => {
    expect(shouldCloseStaleOpen('s2', 's1')).toBe(true)
  })
})

// Measured in the dev app: sent as plain typed characters, `/status` opened the model picker and
// saved a default, because the CLI's own autocomplete had read the slash key by key and the return
// took the highlighted entry. Bracketed paste is what tells it the text is pasted.
describe('ptyWritesFor', () => {
  it('wraps the text in the bracketed-paste markers', () => {
    const [paste] = ptyWritesFor('/status')
    expect(paste).toBe('\u001b[200~/status\u001b[201~')
  })

  it('keeps the return out of the paste, so the two can be written separately', () => {
    const [paste, submit] = ptyWritesFor('hello')
    expect(submit).toBe('\r')
    expect(paste).not.toContain('\r')
  })

  it('leaves a newline inside the message where it was', () => {
    const [paste] = ptyWritesFor('first\nsecond')
    expect(paste).toBe('\u001b[200~first\nsecond\u001b[201~')
  })
})

describe('isSlashCommand', () => {
  it('is true for a command, with or without leading spaces', () => {
    expect(isSlashCommand('/model')).toBe(true)
    expect(isSlashCommand('   /status arg')).toBe(true)
  })

  // The interesting half: a slash inside a sentence is not a command, and raising the notice for one
  // would tell a person their perfectly ordinary message went somewhere it did not.
  it('is false for a message that merely contains a slash', () => {
    expect(isSlashCommand('src/main/ipc.ts 를 봐줘')).toBe(false)
    expect(isSlashCommand('2026/09/11 에 뭐 했지')).toBe(false)
    expect(isSlashCommand('')).toBe(false)
  })
})

describe('modelLineOf', () => {
  const format = (model: string, effort: string): string => `${model} @ ${effort}`

  it('joins the model and the effort', () => {
    expect(modelLineOf({ model: 'Opus 5', effort: 'xhigh' }, format)).toBe('Opus 5 @ xhigh')
  })

  it('draws the model alone rather than an effort with nothing to belong to', () => {
    expect(modelLineOf({ model: 'Opus 5', effort: null }, format)).toBe('Opus 5')
  })

  it('draws nothing at all when the CLI has not said what it is running', () => {
    expect(modelLineOf({ model: null, effort: 'xhigh' }, format)).toBeNull()
    expect(modelLineOf({ model: null, effort: null }, format)).toBeNull()
  })
})

describe('keepWhatIsKnown', () => {
  const codex = (model: string | null, effort: string | null) => ({ model, effort, cli: 'codex' as const })

  // The one this exists for: codex records its model a turn at a time, so between turns the reading
  // that goes through IPC is a pair of nulls while its own screen says the model plainly. Letting the
  // silence through erased the screen's reading every time the transcript ticked.
  it('keeps what is known when the new reading says nothing', () => {
    expect(keepWhatIsKnown(codex('gpt-5.6-sol', 'low'), codex(null, null))).toEqual(
      codex('gpt-5.6-sol', 'low')
    )
  })

  it('takes a reading that does say something', () => {
    expect(keepWhatIsKnown(codex('gpt-5.6-sol', 'low'), codex('gpt-5.6-terra', 'medium'))).toEqual(
      codex('gpt-5.6-terra', 'medium')
    )
  })

  it('fills in one field without losing the other', () => {
    expect(keepWhatIsKnown(codex('gpt-5.6-sol', 'low'), codex('gpt-5.6-terra', null))).toEqual(
      codex('gpt-5.6-terra', 'low')
    )
  })

  // A different CLI is a different session's answer arriving, not a quieter one.
  it('replaces everything when the CLI itself is different', () => {
    const claude = { model: null, effort: null, cli: 'claude' as const }
    expect(keepWhatIsKnown(codex('gpt-5.6-sol', 'low'), claude)).toEqual(claude)
  })
})
