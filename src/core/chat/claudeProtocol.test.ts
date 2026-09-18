import { describe, it, expect } from 'vitest'
import * as F from './claudeFixtures'
import {
  decodeClaudeFrame, encodeUserTurn, encodeControlRequest, encodeControlSuccess, encodeControlError,
  CLAUDE_STREAM_ARGS, claudeLaunchArgs, claudeModelsOf, decodeClaudeRequest, encodeClaudeAnswer, claudeEffectsOf
} from './claudeProtocol'
import { emptyAnswers, togglePick } from '../prompts/askUserQuestion'

const req = (line: string) => {
  const f = decodeClaudeFrame(line)
  if (f?.kind !== 'control_request') throw new Error('not a control_request')
  return f
}
const okResponse = (line: string) => {
  const f = decodeClaudeFrame(line)
  if (f?.kind !== 'control_response' || !f.ok) throw new Error('not an ok control_response')
  return f.response
}
const message = (line: string) => {
  const f = decodeClaudeFrame(line)
  if (f?.kind !== 'message') throw new Error('not a message')
  return f
}

describe('frames', () => {
  it('tells control responses, control requests and messages apart', () => {
    expect(decodeClaudeFrame(F.INITIALIZE_RESPONSE)).toMatchObject({ kind: 'control_response', requestId: 'astera-1', ok: true })
    expect(decodeClaudeFrame(F.CAN_USE_TOOL_ASK)).toMatchObject({ kind: 'control_request', subtype: 'can_use_tool' })
    expect(decodeClaudeFrame(F.SYSTEM_INIT)).toMatchObject({ kind: 'message', type: 'system', subtype: 'init' })
    expect(decodeClaudeFrame(F.ASSISTANT_ASK_TOOL_USE)).toMatchObject({ kind: 'message', type: 'assistant', subtype: null })
    expect(decodeClaudeFrame(F.USER_ECHO_ASK_RESULT)).toMatchObject({ kind: 'message', type: 'user', subtype: null })
    expect(decodeClaudeFrame(F.USER_ECHO_WRITE_DENIED)).toMatchObject({ kind: 'message', type: 'user', subtype: null })
    expect(decodeClaudeFrame(F.RESULT_SUCCESS_ASK)).toMatchObject({ kind: 'message', type: 'result', subtype: 'success' })
    expect(decodeClaudeFrame(F.RESULT_WITH_DENIALS)).toMatchObject({ kind: 'message', type: 'result', subtype: 'success' })
    expect(decodeClaudeFrame(F.INTERRUPT_RESPONSE)).toMatchObject({ kind: 'control_response', requestId: 'astera-2', ok: true })
    expect(decodeClaudeFrame(F.SET_MODE_RESPONSE)).toMatchObject({ kind: 'control_response', requestId: 'astera-3', ok: true })
    expect(decodeClaudeFrame(F.RATE_LIMIT_EVENT)).toMatchObject({ kind: 'message', type: 'rate_limit_event', subtype: null })
    expect(decodeClaudeFrame('not json')).toBeNull()
    expect(decodeClaudeFrame('{"no":"type"}')).toBeNull()
  })

  it('encodes a user turn that decodes back to the exact frame', () => {
    const line = encodeUserTurn('hi')
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null })
    expect(message(line)).toMatchObject({ type: 'user', subtype: null })
  })

  it('encodes a control request that decodes back to the exact frame', () => {
    const line = encodeControlRequest('a-1', { subtype: 'interrupt' })
    expect(JSON.parse(line)).toEqual({ type: 'control_request', request_id: 'a-1', request: { subtype: 'interrupt' } })
    expect(req(line)).toMatchObject({ requestId: 'a-1', subtype: 'interrupt' })
  })

  it('encodes control success and control error', () => {
    expect(JSON.parse(encodeControlSuccess('r1', { ok: true }))).toEqual({
      type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { ok: true } }
    })
    expect(JSON.parse(encodeControlError('r1', 'boom'))).toEqual({
      type: 'control_response', response: { subtype: 'error', request_id: 'r1', error: 'boom' }
    })
  })
})

describe('claudeLaunchArgs', () => {
  it('is exactly CLAUDE_STREAM_ARGS with a fresh session and no bypass', () => {
    expect(claudeLaunchArgs({ bypass: false })).toEqual([...CLAUDE_STREAM_ARGS])
  })
  it('adds resume, the bypass pair and the model, in that order', () => {
    expect(claudeLaunchArgs({ resumeSessionId: 's1', bypass: true, model: 'sonnet' })).toEqual([
      ...CLAUDE_STREAM_ARGS,
      '--resume=s1',
      '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
      '--model', 'sonnet'
    ])
  })
})

describe('claudeModelsOf', () => {
  it('reads the models array out of the initialize response', () => {
    const models = claudeModelsOf(okResponse(F.INITIALIZE_RESPONSE))
    expect(models.length).toBe(5)
    expect(models[0]).toMatchObject({ id: 'default', isDefault: true })
    expect(models[0].effortLevels).toBeDefined()
  })
  it('reads the same ids out of the list_models response', () => {
    const models = claudeModelsOf(okResponse(F.LIST_MODELS_RESPONSE))
    expect(models.map((m) => m.id)).toEqual(['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'])
  })
})

describe('decodeClaudeRequest', () => {
  it('turns AskUserQuestion into a question form', () => {
    const frame = req(F.CAN_USE_TOOL_ASK)
    const d = decodeClaudeRequest(frame)
    expect(d?.request).toMatchObject({ kind: 'question' })
    if (d?.request.kind !== 'question') throw new Error()
    expect(d.request.form.questions.map((q) => q.header)).toEqual(['Format', 'Sections'])
    expect(d.request.form.questions[1].multiSelect).toBe(true)
    expect(d.toolUseId).toBe('toolu_01SJQsufkgnRqyV9WF22Jbte')

    let answers = emptyAnswers(d.request.form)
    answers = togglePick(d.request.form, answers, 0, 1)
    answers = togglePick(d.request.form, answers, 1, 0)
    answers = togglePick(d.request.form, answers, 1, 1)
    const line = encodeClaudeAnswer(frame, d, { kind: 'question', answers })
    const updatedInput = JSON.parse(line).response.response.updatedInput
    expect(updatedInput.answers).toEqual({
      'How should I format the output?': 'Detailed',
      'Which sections should I include?': 'Introduction, Methods'
    })
    expect(updatedInput.questions).toEqual(JSON.parse(F.CAN_USE_TOOL_ASK).request.input.questions)
  })

  it('turns Write into an approval, and offers acceptForSession only when Claude does', () => {
    const frame = req(F.CAN_USE_TOOL_WRITE)
    const d = decodeClaudeRequest(frame)
    expect(d?.request).toMatchObject({ kind: 'approval' })
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.about.tool).toBe('Write')
    expect(d.request.about.lines.some((l) => l.includes('astera-claude-probe.txt'))).toBe(true)
    expect(d.request.decisions).toEqual(['accept', 'acceptForSession', 'decline'])
    expect(d.toolUseId).toBe('toolu_01Bx48jWzAj1rTvixLjacPs1')

    expect(JSON.parse(encodeClaudeAnswer(frame, d, { kind: 'approval', decision: 'decline' }))).toMatchObject({
      response: { response: { behavior: 'deny', message: 'User declined in Astera' } }
    })
    const forSession = JSON.parse(encodeClaudeAnswer(frame, d, { kind: 'approval', decision: 'acceptForSession' }))
    expect(forSession.response.response.updatedPermissions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  })

  it('drops acceptForSession when suppress_always_allow_rule is set', () => {
    const raw = JSON.parse(F.CAN_USE_TOOL_WRITE)
    raw.request.suppress_always_allow_rule = true
    const frame = req(JSON.stringify(raw))
    const d = decodeClaudeRequest(frame)
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.decisions).toEqual(['accept', 'decline'])
  })

  it('drops acceptForSession when there are no permission_suggestions', () => {
    const raw = JSON.parse(F.CAN_USE_TOOL_WRITE)
    delete raw.request.permission_suggestions
    const frame = req(JSON.stringify(raw))
    const d = decodeClaudeRequest(frame)
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.decisions).toEqual(['accept', 'decline'])
  })

  it('an unsupported control_request subtype decodes to null', () => {
    const line = JSON.stringify({ type: 'control_request', request_id: 'x', request: { subtype: 'request_user_dialog' } })
    expect(decodeClaudeRequest(req(line))).toBeNull()
  })
})

describe('encodeClaudeAnswer', () => {
  it('refuses a question answer for an approval — the pairing is the caller’s mistake, not a wire case', () => {
    const frame = req(F.CAN_USE_TOOL_WRITE)
    const d = decodeClaudeRequest(frame)
    if (!d) throw new Error()
    expect(() => encodeClaudeAnswer(frame, d, { kind: 'question', answers: [] })).toThrow(/question answer/)
  })

  it('refuses a request that carries no input — every request this codec decodes has one', () => {
    const frame = req(F.CAN_USE_TOOL_WRITE)
    const d = decodeClaudeRequest(frame)
    if (!d) throw new Error()
    const { input: _input, ...withoutInput } = d
    expect(() => encodeClaudeAnswer(frame, withoutInput, { kind: 'approval', decision: 'accept' })).toThrow(/no input/)
  })
})

describe('claudeEffectsOf', () => {
  it('system/init announces the thread, the model, the permission mode, the turn and working -- in that order', () => {
    expect(claudeEffectsOf(message(F.SYSTEM_INIT))).toEqual([
      { type: 'thread', threadId: '04c490a7-0ab2-419a-8c55-fdb8aea99ae0', rolloutPath: null },
      { type: 'event', event: { type: 'model', model: { model: 'claude-fable-5-1', effort: null, permissionMode: 'default' } } },
      { type: 'permissionMode', mode: 'default' },
      { type: 'turn', turnId: '04c490a7-0ab2-419a-8c55-fdb8aea99ae0' },
      { type: 'event', event: { type: 'status', status: 'working' } }
    ])
  })

  it('system/status is only a permission-mode marker', () => {
    expect(claudeEffectsOf(message(F.SYSTEM_STATUS_PLAN))).toEqual([{ type: 'permissionMode', mode: 'plan' }])
  })

  it('a successful result ends the turn and goes idle without an error', () => {
    expect(claudeEffectsOf(message(F.RESULT_SUCCESS_ASK))).toEqual([
      { type: 'turn', turnId: null },
      // The same frame also reports what the turn left in the context; its own test is further down.
      { type: 'usage', usedTokens: 57059, windowByModel: { 'claude-haiku-4-5-20251001': 200000, 'claude-fable-5-1': 1000000 } },
      { type: 'event', event: { type: 'status', status: 'idle' } }
    ])
  })

  it('an aborted (interrupted) result ends the turn and goes idle without an error', () => {
    expect(claudeEffectsOf(message(F.RESULT_ABORTED))).toEqual([
      { type: 'turn', turnId: null },
      { type: 'event', event: { type: 'status', status: 'idle' } }
    ])
  })

  it('a real error reports its message before going idle', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'completed', session_id: 's1' })
    expect(claudeEffectsOf(message(line))).toEqual([
      { type: 'turn', turnId: null },
      { type: 'event', event: { type: 'error', message: 'error_max_turns' } },
      { type: 'event', event: { type: 'status', status: 'idle' } }
    ])
  })

  it('a user echo with a tool_result reports the tool as resolved', () => {
    expect(claudeEffectsOf(message(F.USER_ECHO_ASK_RESULT))).toEqual([{ type: 'resolvedTool', toolUseId: 'toolu_01SJQsufkgnRqyV9WF22Jbte' }])
  })

  it('everything else is nothing', () => {
    // RATE_LIMIT_EVENT is no longer an example of this — it now produces a rateLimit effect (below) —
    // so an unhandled message type stands in for it.
    const line = JSON.stringify({ type: 'stream_event', session_id: 's' })
    expect(claudeEffectsOf(message(line))).toEqual([])
  })

  it('a rate_limit_event becomes a rateLimit effect with the wire fields normalised', () => {
    const effects = claudeEffectsOf(message(F.RATE_LIMIT_EVENT))
    expect(effects).toEqual([
      {
        type: 'rateLimit',
        info: {
          status: 'allowed_warning',
          resetsAt: 1789552800 * 1000,
          utilization: 0.99,
          window: 'seven_day',
          source: 'event',
          // Both windows ride along for the status bar; the fields above name only the one that fired.
          windows: {
            session: { usedPercent: 42, resetsAt: new Date(1789539600 * 1000).toISOString() },
            weekly: { usedPercent: 99, resetsAt: new Date(1789552800 * 1000).toISOString() }
          }
        }
      }
    ])
  })

  it('a rejected event carries its status through; a missing resetsAt is null', () => {
    const line = F.RATE_LIMIT_EVENT.replace('"status":"allowed_warning"', '"status":"rejected"').replace('"resetsAt":1789552800,', '')
    const effects = claudeEffectsOf(message(line))
    expect(effects[0]).toMatchObject({ type: 'rateLimit', info: { status: 'rejected', resetsAt: null, source: 'event' } })
  })

  it('a failed result whose text is a limit phrase adds a rejected rateLimit beside the error', () => {
    // matchesLimitPhrase requires the window name between "your" and "limit" (detect.ts's LIMIT_RE) —
    // "session" stands in for it here. Split by concatenation, same convention as claudeSignal.test.ts's
    // LIMIT_TEXT, so this file carries no bare limit phrase for the repo self-trigger scan to catch.
    const limitText = "You've hit your " + 'session limit · resets 3pm'
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: limitText, session_id: 's' })
    const effects = claudeEffectsOf(message(line))
    expect(effects.map((e) => e.type)).toEqual(['turn', 'event', 'rateLimit', 'event']) // turn null, error, rateLimit, idle
    expect(effects[2]).toMatchObject({ type: 'rateLimit', info: { status: 'rejected', source: 'result' } })
  })

  it('a failed result whose text is not a limit phrase adds no rateLimit', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 's' })
    expect(claudeEffectsOf(message(line)).map((e) => e.type)).toEqual(['turn', 'event', 'event'])
  })

  it('an assistant frame with error rate_limit adds a rejected rateLimit beside working', () => {
    const line = JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [] }, session_id: 's' })
    const effects = claudeEffectsOf(message(line))
    expect(effects.map((e) => e.type)).toEqual(['event', 'rateLimit'])
    expect(effects[1]).toMatchObject({ type: 'rateLimit', info: { status: 'rejected', source: 'assistant' } })
  })
})

// The status bar's three chips have no statusLine to read in a chat session: that capture is planted
// by the pty manager alone. What the pty reads off the statusLine, a chat session gets here instead.
describe('claudeEffectsOf — what the usage chips need', () => {
  it('a result frame reports the tokens the turn left in the context, and every window offered', () => {
    const effects = claudeEffectsOf(message(F.RESULT_SUCCESS_ASK))
    expect(effects).toContainEqual({
      type: 'usage',
      // input + cache_creation + cache_read + output. Checked against four real statusLine payloads:
      // this sum over context_window_size reproduces the used_percentage the CLI writes itself.
      usedTokens: 34 + 0 + 56764 + 261,
      // Every model in the frame, the sub-agent's included. Which one the conversation is on is a
      // question this frame cannot answer, and the adapter can.
      windowByModel: { 'claude-haiku-4-5-20251001': 200000, 'claude-fable-5-1': 1000000 }
    })
  })

  it('a result frame with no usage of its own reports nothing', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' })
    expect(claudeEffectsOf(message(line)).map((e) => e.type)).toEqual(['turn', 'event'])
  })

  it('an aborted turn, whose usage is all zeros, reports nothing', () => {
    // Blanking a chip that was reading correctly a moment ago is worse than leaving it.
    expect(claudeEffectsOf(message(F.RESULT_ABORTED)).map((e) => e.type)).not.toContain('usage')
  })

  it('a rate_limit_event carries both windows, not only the one that fired', () => {
    const effects = claudeEffectsOf(message(F.RATE_LIMIT_EVENT))
    expect(effects[0]).toMatchObject({
      type: 'rateLimit',
      info: {
        // utilization on this wire is 0..1, where the statusLine's own field is already a percentage
        windows: {
          session: { usedPercent: 42, resetsAt: new Date(1789539600 * 1000).toISOString() },
          weekly: { usedPercent: 99, resetsAt: new Date(1789552800 * 1000).toISOString() }
        }
      }
    })
  })

  it('a rate limit inferred from a rejected turn has no windows to carry', () => {
    const limitText = "You've hit your " + 'session limit · resets 3pm'
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: limitText, session_id: 's' })
    const effects = claudeEffectsOf(message(line))
    expect(effects.find((e) => e.type === 'rateLimit')).toMatchObject({ info: { windows: null } })
  })
})

// The composer's mode control offers three, so the wire's own value is carried rather than reduced to
// "is it plan". A boolean could not tell acceptEdits from default.
describe('claudeEffectsOf — the permission mode', () => {
  const statusWith = (mode: string): string =>
    F.SYSTEM_STATUS_PLAN.replace('"permissionMode":"plan"', `"permissionMode":"${mode}"`)

  it('carries acceptEdits through as itself', () => {
    expect(claudeEffectsOf(message(statusWith('acceptEdits')))).toEqual([
      { type: 'permissionMode', mode: 'acceptEdits' }
    ])
  })

  it('carries plan and default through as themselves', () => {
    expect(claudeEffectsOf(message(statusWith('plan')))).toEqual([{ type: 'permissionMode', mode: 'plan' }])
    expect(claudeEffectsOf(message(statusWith('default')))).toEqual([{ type: 'permissionMode', mode: 'default' }])
  })

  it('folds a mode the control does not offer onto default', () => {
    // bypassPermissions is a real mode the CLI can be started in (the spawn dialog's own checkbox) and
    // not one of the three offered here. Naming it as one of the three would be a lie about what the
    // button is showing; default is the honest neutral, and picking it really does step the CLI down.
    expect(claudeEffectsOf(message(statusWith('bypassPermissions')))).toEqual([
      { type: 'permissionMode', mode: 'default' }
    ])
    expect(claudeEffectsOf(message(statusWith('something-new')))).toEqual([
      { type: 'permissionMode', mode: 'default' }
    ])
  })

  it('reports the mode on the init frame beside the model', () => {
    const effects = claudeEffectsOf(message(F.SYSTEM_INIT))
    expect(effects).toContainEqual({ type: 'permissionMode', mode: 'default' })
    expect(effects.find((e) => e.type === 'event' && e.event.type === 'model')).toMatchObject({
      event: { model: { permissionMode: 'default' } }
    })
  })
})
