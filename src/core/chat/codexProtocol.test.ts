import { describe, it, expect } from 'vitest'
import * as F from './codexFixtures'
import {
  decodeFrame, encodeRequest, encodeResponse, encodeError, UNSUPPORTED_REQUEST,
  initializeParams, threadStartParams, threadResumeParams, threadOf, planEffortOf, modelsOf,
  turnStartParams, decodeServerRequest, encodeAnswer, effectsOf, askFormOf
} from './codexProtocol'
import { emptyAnswers, togglePick, setOther } from '../prompts/askUserQuestion'

const req = (line: string) => { const f = decodeFrame(line); if (f?.kind !== 'request') throw new Error('not a request'); return f }
const note = (line: string) => { const f = decodeFrame(line); if (f?.kind !== 'notification') throw new Error('not a notification'); return f }
const result = (line: string) => { const f = decodeFrame(line); if (f?.kind !== 'response') throw new Error('not a response'); return f.result }

describe('frames', () => {
  it('tells responses, server requests and notifications apart', () => {
    expect(decodeFrame(F.THREAD_START_RESULT)?.kind).toBe('response')
    expect(decodeFrame(F.REQUEST_USER_INPUT)).toMatchObject({ kind: 'request', id: 0, method: 'item/tool/requestUserInput' })
    expect(decodeFrame(F.TURN_STARTED)).toMatchObject({ kind: 'notification', method: 'turn/started' })
    expect(decodeFrame('not json')).toBeNull()
    expect(decodeFrame('{"jsonrpc":"2.0"}')).toBeNull()
  })
  it('encodes without a trailing newline and round-trips', () => {
    const line = encodeRequest('a1-7', 'turn/interrupt', { threadId: 't', turnId: 'u' })
    expect(line.endsWith('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ id: 'a1-7', method: 'turn/interrupt', params: { threadId: 't', turnId: 'u' } })
    expect(JSON.parse(encodeError(3, UNSUPPORTED_REQUEST, 'unsupported request: x'))).toEqual({ id: 3, error: { code: -32601, message: 'unsupported request: x' } })
  })
})

describe('handshake params', () => {
  it('asks for the experimental API and opts out of the delta streams', () => {
    const p = initializeParams('1.3.23')
    expect(p.clientInfo).toEqual({ name: 'astera', title: 'Astera', version: '1.3.23' })
    expect(p.capabilities.experimentalApi).toBe(true)
    expect(p.capabilities.optOutNotificationMethods).toContain('item/agentMessage/delta')
  })
  it('uses the kebab-case policies, and the bypass pair for the bypass box', () => {
    expect(threadStartParams({ cwd: 'D:/x', bypass: false })).toEqual({ cwd: 'D:/x', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(threadStartParams({ cwd: 'D:/x', bypass: true })).toEqual({ cwd: 'D:/x', approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(threadResumeParams({ threadId: 't1', cwd: 'D:/x', bypass: false })).toMatchObject({ threadId: 't1', excludeTurns: true, approvalPolicy: 'on-request' })
  })
  it('reads the thread id, the rollout path and the model out of thread/start and thread/resume results', () => {
    expect(threadOf(result(F.THREAD_START_RESULT))).toEqual({
      threadId: '01a0a6cb-43a2-7d71-994f-72e53764fbc1',
      rolloutPath: expect.stringMatching(/rollout-2026-09-16T05-38-54-01a0a6cb-43a2-7d71-994f-72e53764fbc1\.jsonl$/),
      model: 'gpt-6-astra', effort: 'xhigh'
    })
    expect(threadOf(result(F.THREAD_RESUME_RESULT))?.threadId).toBe('01a0a6cd-7f52-7690-a1ae-d7c9cb688c35')
    expect(threadOf({})).toBeNull()
  })
  it('finds the plan mode effort and parses the model list', () => {
    expect(planEffortOf(result(F.COLLAB_MODES_RESULT))).toBe('medium')
    const models = modelsOf(result(F.MODEL_LIST_RESULT))
    expect(models[0]).toMatchObject({ provider: 'codex', id: 'gpt-6-astra', isDefault: true })
    expect(models.length).toBe(5)
  })
})

describe('turnStartParams', () => {
  const base = { threadId: 't', text: 'hi', model: null, effort: null, planEffort: 'medium', threadModel: 'gpt-6-astra' }
  it('sends the plan struct with the thread model when the person picked none', () => {
    expect(turnStartParams({ ...base, planMode: true })).toEqual({
      threadId: 't', input: [{ type: 'text', text: 'hi' }],
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'medium' } }
    })
  })
  it('sends the default struct, the model and the effort overrides when picked', () => {
    expect(turnStartParams({ ...base, planMode: false, model: 'gpt-5.5', effort: 'high' })).toEqual({
      threadId: 't', input: [{ type: 'text', text: 'hi' }], model: 'gpt-5.5', effort: 'high',
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5' } }
    })
  })
  it('sends no struct at all when no model is known — a struct without a model is refused', () => {
    expect(turnStartParams({ ...base, planMode: true, threadModel: null })).toEqual({ threadId: 't', input: [{ type: 'text', text: 'hi' }] })
  })
})

describe('server requests', () => {
  const noChanges = new Map()
  it('turns requestUserInput into a question form and answers it in Codex’s shape', () => {
    const d = decodeServerRequest(req(F.REQUEST_USER_INPUT), noChanges)
    expect(d?.request).toMatchObject({ id: '0', kind: 'question' })
    if (d?.request.kind !== 'question') throw new Error()
    expect(d.request.form.questions.map((q) => q.header)).toEqual(['Format', 'Sections'])
    expect(d.request.form.questions[0].options).toEqual([{ label: 'Summary', description: 'Brief overview' }, { label: 'Detailed', description: 'Full explanation' }])
    expect(d.request.form.questions[0].multiSelect).toBe(false)
    expect(d.questionIds).toEqual(['format', 'sections'])
    let answers = emptyAnswers(d.request.form)
    answers = togglePick(d.request.form, answers, 0, 1)
    answers = setOther(d.request.form, answers, 1, 'Methods and a glossary')
    expect(JSON.parse(encodeAnswer(0, d, { kind: 'question', answers }))).toEqual({
      id: 0, result: { answers: { format: { answers: ['Detailed'] }, sections: { answers: ['Methods and a glossary'] } } }
    })
  })
  it('a question with options: null is free text only', () => {
    const form = askFormOf([{ id: 'q', header: 'H', question: 'Q?', isOther: true, isSecret: false, options: null }])
    expect(form.questions[0].options).toEqual([])
  })
  it('turns a command approval into the readable command, and offers acceptForSession only when Codex does', () => {
    const d = decodeServerRequest(req(F.COMMAND_APPROVAL), noChanges)
    expect(d?.request).toEqual({ id: '0', kind: 'approval', about: { tool: 'shell', lines: ['git log --oneline -1'] }, decisions: ['accept', 'decline'] })
    expect(JSON.parse(encodeAnswer(0, d!, { kind: 'approval', decision: 'accept' }))).toEqual({ id: 0, result: { decision: 'accept' } })
  })
  it('a file change approval shows the paths and the diff that item/started delivered for that itemId', () => {
    const fx = effectsOf(note(F.FILECHANGE_ITEM_STARTED)).find((e) => e.type === 'fileChange')
    if (fx?.type !== 'fileChange') throw new Error()
    expect(fx.itemId).toBe('exec-f46468cb-e0ce-43b7-800b-49e53a011824')
    const d = decodeServerRequest(req(F.FILECHANGE_APPROVAL), new Map([[fx.itemId, fx.changes]]))
    expect(d?.request).toMatchObject({ kind: 'approval', about: { tool: 'apply_patch' } })
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.about.lines[0]).toBe('add D:\\parsingk\\astera\\astera-probe-3.txt')
    expect(d.request.about.lines[1]).toBe('probe')
    expect(JSON.parse(encodeAnswer(0, d, { kind: 'approval', decision: 'decline' }))).toEqual({ id: 0, result: { decision: 'decline' } })
  })
  it('a long diff is cut to 60 lines whose last one is the ellipsis', () => {
    const diff = Array.from({ length: 70 }, (_, i) => `+line ${i}`).join('\n') + '\n'
    const started = JSON.stringify({ method: 'item/started', params: { item: { type: 'fileChange', id: 'it-1', changes: [{ path: 'D:/x.txt', kind: { type: 'update' }, diff }], status: 'inProgress' } } })
    const fx = effectsOf(note(started)).find((e) => e.type === 'fileChange')
    if (fx?.type !== 'fileChange') throw new Error()
    // The trailing newline must not become a 71st, empty line — diffLines drops exactly that one.
    expect(fx.changes[0].diff.endsWith('\n')).toBe(true)
    const d = decodeServerRequest(req(JSON.stringify({ method: 'item/fileChange/requestApproval', id: 0, params: { itemId: 'it-1' } })), new Map([[fx.itemId, fx.changes]]))
    if (d?.request.kind !== 'approval') throw new Error()
    const lines = d.request.about.lines
    expect(lines.length).toBe(60)
    expect(lines[0]).toBe('update D:/x.txt')
    expect(lines[58]).toBe('+line 57')
    expect(lines[59]).toBe('…')
  })
  it('a one-line diff with a final newline is one line, not two', () => {
    const started = JSON.stringify({ method: 'item/started', params: { item: { type: 'fileChange', id: 'it-2', changes: [{ path: 'D:/y.txt', kind: { type: 'add' }, diff: 'probe\n' }], status: 'inProgress' } } })
    const fx = effectsOf(note(started)).find((e) => e.type === 'fileChange')
    if (fx?.type !== 'fileChange') throw new Error()
    const d = decodeServerRequest(req(JSON.stringify({ method: 'item/fileChange/requestApproval', id: 0, params: { itemId: 'it-2' } })), new Map([[fx.itemId, fx.changes]]))
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.about.lines).toEqual(['add D:/y.txt', 'probe'])
  })
  it('a command approval appends its reason under the command', () => {
    const line = JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 0, params: { command: 'curl https://example.com', commandActions: [{ type: 'unknown', command: 'curl https://example.com' }], reason: '`curl …` requires approval: a rule says so' } })
    const d = decodeServerRequest(req(line), noChanges)
    if (d?.request.kind !== 'approval') throw new Error()
    expect(d.request.about.lines).toEqual(['curl https://example.com', '`curl …` requires approval: a rule says so'])
  })
  it('acceptForSession is offered when Codex lists it and when it says nothing at all', () => {
    const withIt = JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 0, params: { command: 'ls', availableDecisions: ['accept', 'acceptForSession', 'cancel'] } })
    const silent = JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 0, params: { command: 'ls' } })
    const decisionsOf = (l: string): unknown => {
      const d = decodeServerRequest(req(l), noChanges)
      if (d?.request.kind !== 'approval') throw new Error()
      return d.request.decisions
    }
    expect(decisionsOf(withIt)).toEqual(['accept', 'acceptForSession', 'decline'])
    expect(decisionsOf(silent)).toEqual(['accept', 'acceptForSession', 'decline'])
  })
  it('an unknown request decodes to null', () => {
    expect(decodeServerRequest({ kind: 'request', id: 9, method: 'item/permissions/requestApproval', params: {} }, noChanges)).toBeNull()
  })
})

describe('effectsOf', () => {
  it('turn/started is the turn id and working; turn/completed is no turn and idle', () => {
    expect(effectsOf(note(F.TURN_STARTED))).toEqual([{ type: 'turn', turnId: '01a0a6cb-446f-7121-b8cb-970a1d5e35d5' }, { type: 'event', event: { type: 'status', status: 'working' } }])
    expect(effectsOf(note(F.TURN_COMPLETED_OK))).toEqual([{ type: 'turn', turnId: null }, { type: 'event', event: { type: 'status', status: 'idle' } }])
    expect(effectsOf(note(F.TURN_COMPLETED_INTERRUPTED))).toEqual([{ type: 'turn', turnId: null }, { type: 'event', event: { type: 'status', status: 'idle' } }])
  })
  it('a failed turn reports its message before going idle', () => {
    const failed = JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', items: [], itemsView: 'summary', status: 'failed', error: { message: 'rate limited', codexErrorInfo: null, additionalDetails: null, misalignment: null }, startedAt: 1, completedAt: 2, durationMs: 1 } } })
    expect(effectsOf(note(failed))).toEqual([
      { type: 'turn', turnId: null },
      { type: 'event', event: { type: 'error', message: 'rate limited' } },
      { type: 'event', event: { type: 'status', status: 'idle' } }
    ])
  })
  it('thread/settings/updated reports the model, the effort and whether plan mode is on', () => {
    expect(effectsOf(note(F.THREAD_SETTINGS_UPDATED_PLAN))).toEqual([{ type: 'event', event: { type: 'model', model: { model: 'gpt-6-astra', effort: 'medium', planMode: true } } }])
  })
  it('serverRequest/resolved and thread/started carry their ids', () => {
    expect(effectsOf(note(F.SERVER_REQUEST_RESOLVED))).toEqual([{ type: 'resolved', requestId: 0 }])
    expect(effectsOf(note(F.THREAD_STARTED))[0]).toMatchObject({ type: 'thread', threadId: '01a0a6cb-43a2-7d71-994f-72e53764fbc1' })
  })
  it('everything else is nothing', () => {
    expect(effectsOf(note(JSON.stringify({ method: 'account/rateLimits/updated', params: {} })))).toEqual([])
  })
})
