import { describe, it, expect } from 'vitest'
import { decidePermission, READ_KINDS, WRITE_KINDS } from './permission'

const ALLOW = { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }
const ALWAYS = { optionId: 'allow-always', name: 'Always', kind: 'allow_always' }
const REJECT = { optionId: 'reject', name: 'No', kind: 'reject_once' }
const REJECT_ALWAYS = { optionId: 'reject-always', name: 'Never', kind: 'reject_always' }
const req = (kind: unknown, options: unknown[], sessionId = 's1'): unknown => ({
  sessionId,
  toolCall: { toolCallId: 't', ...(kind === undefined ? {} : { kind }), title: 'x', status: 'pending' },
  options
})
const selected = (optionId: string, allowed: boolean): unknown => ({ outcome: { outcome: 'selected', optionId }, allowed })
const CANCELLED = { outcome: { outcome: 'cancelled' }, allowed: false }

describe('kinds', () => {
  it('names the read and write kinds of spec 3.3', () => {
    expect([...READ_KINDS]).toEqual(['read', 'search', 'think'])
    expect([...WRITE_KINDS]).toEqual(['edit', 'delete', 'move'])
  })
})

describe('decidePermission', () => {
  it.each(['read', 'search', 'think'])('%s selects the first allow_once option', (kind) => {
    expect(decidePermission('s1', req(kind, [REJECT, ALWAYS, ALLOW]))).toEqual(selected('allow-once', true))
  })

  it('never selects allow_always: with no allow_once a read is refused', () => {
    expect(decidePermission('s1', req('read', [ALWAYS, REJECT]))).toEqual(selected('reject', false))
  })

  it.each(['edit', 'delete', 'move', 'execute', 'fetch', 'switch_mode', 'other'])('%s selects the first reject_once option', (kind) => {
    expect(decidePermission('s1', req(kind, [ALLOW, REJECT_ALWAYS, REJECT]))).toEqual(selected('reject', false))
  })

  it('a missing kind is refused', () => {
    expect(decidePermission('s1', req(undefined, [ALLOW, REJECT]))).toEqual(selected('reject', false))
  })

  it('answers cancelled when there is no reject_once option', () => {
    expect(decidePermission('s1', req('edit', [ALLOW, REJECT_ALWAYS]))).toEqual(CANCELLED)
    expect(decidePermission('s1', req('read', [ALWAYS]))).toEqual(CANCELLED)
  })

  it('another session id is refused even for a read', () => {
    expect(decidePermission('s1', req('read', [ALLOW, REJECT], 'other'))).toEqual(selected('reject', false))
  })

  it.each([null, 'x', 7, {}, { sessionId: 's1' }, { sessionId: 's1', toolCall: {}, options: 'no' }])('malformed params %j are refused', (p) => {
    expect(decidePermission('s1', p)).toEqual(CANCELLED)
  })

  it('skips an option that is not an object or has no optionId', () => {
    expect(decidePermission('s1', req('edit', [null, { kind: 'reject_once' }, REJECT]))).toEqual(selected('reject', false))
  })
})
