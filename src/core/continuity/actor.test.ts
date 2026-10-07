import { describe, it, expect } from 'vitest'
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import { emptyState, type OrchState } from '../orchestration/state'
import { actorFromJson, actorOf, commitStamp, controllerOf, isJournalActor, mcpClientOf, mcpRemoteOf } from './actor'

describe('the journal actor (J4)', () => {
  it('reads the four surfaces, with or without a session', () => {
    expect(actorFromJson('{"surface":"cli"}')).toEqual({ surface: 'cli' })
    expect(actorFromJson('{"surface":"agent","sessionId":"ses_1"}')).toEqual({ surface: 'agent', sessionId: 'ses_1' })
    for (const s of ['desktop', 'cli', 'agent', 'host']) expect(isJournalActor({ surface: s })).toBe(true)
  })
  it('reads a v2 row, a foreign surface and broken JSON as unknown (null), inferring nothing', () => {
    expect(actorFromJson(null)).toBeNull()
    expect(actorFromJson(undefined)).toBeNull()
    expect(actorFromJson('{"surface":"robot"}')).toBeNull()
    expect(actorFromJson('{"surface":"cli","sessionId":7}')).toBeNull()
    expect(actorFromJson('{')).toBeNull()
  })
})

describe('actorOf (J4, P5)', () => {
  const NOW = '2026-09-26T10:00:00.000Z'
  const state = {
    ...emptyState(),
    dispatches: [{ id: 'dsp_1', sessionId: 'ses_w' }, { id: 'dsp_0', sessionId: 'ses_old', endedAt: NOW }],
    runs: [{ id: 'run_1', coordinatorSessionId: 'ses_c' }]
  } as unknown as OrchState

  it('the app is named by its connection’s role', () => {
    expect(actorOf({ sessionId: '', role: 'app', state })).toEqual({ surface: 'desktop' })
    expect(actorOf({ sessionId: APP_CALLER, role: 'app', state })).toEqual({ surface: 'desktop' })
  })
  // Final review M1: the reserved caller ids are one environment variable away for any shell or agent.
  // Only the app's own connection counts as the desktop; the Host's own commands never come through here.
  it('a caller that is not the app claiming a reserved caller id is the CLI', () => {
    for (const sessionId of [HOST_CALLER, APP_CALLER]) {
      expect(actorOf({ sessionId, role: 'cli', state })).toEqual({ surface: 'cli', sessionId })
      expect(actorOf({ sessionId, state })).toEqual({ surface: 'cli', sessionId })
    }
  })
  it('a session with an open Dispatch or a Run to coordinate is an agent', () => {
    expect(actorOf({ sessionId: 'ses_w', role: 'cli', state })).toEqual({ surface: 'agent', sessionId: 'ses_w' })
    expect(actorOf({ sessionId: 'ses_c', role: 'cli', state })).toEqual({ surface: 'agent', sessionId: 'ses_c' })
  })
  it('anything else is the CLI, with its session when it has one', () => {
    expect(actorOf({ sessionId: '', role: 'cli', state })).toEqual({ surface: 'cli' })
    expect(actorOf({ sessionId: 'ses_old', role: 'cli', state })).toEqual({ surface: 'cli', sessionId: 'ses_old' })
    expect(actorOf({ sessionId: 'ses_w', state: null })).toEqual({ surface: 'cli', sessionId: 'ses_w' })
  })
  it('a stamp names the Host life and the version (P1)', () => {
    expect(commitStamp('2026-09-26T01:00:00.000Z', 5)).toBe('2026-09-26T01:00:00.000Z#5')
    expect(commitStamp('2026-09-26T01:00:00.000Z', 'load')).toBe('2026-09-26T01:00:00.000Z#load')
    expect(commitStamp('a', 5)).not.toBe(commitStamp('b', 5))
  })
})

describe('the mcp surface', () => {
  it('an MCP caller is recorded as mcp, whatever session it names', () => {
    expect(actorOf({ sessionId: '', role: 'mcp', state: null })).toEqual({ surface: 'mcp' })
    expect(actorOf({ sessionId: 'sess_1', role: 'mcp', state: null })).toEqual({ surface: 'mcp' })
  })
  it('a row written with the mcp surface reads back', () => {
    expect(isJournalActor({ surface: 'mcp' })).toBe(true)
    expect(actorFromJson('{"surface":"mcp"}')).toEqual({ surface: 'mcp' })
  })
})

// MCP spec §29: which client acted. The client names itself, so its name is untrusted input.
describe('the MCP client on the actor', () => {
  it('keeps a plain name and version', () => {
    expect(mcpClientOf({ name: 'claude-code', version: '1.2.3' })).toEqual({ name: 'claude-code', version: '1.2.3' })
    expect(mcpClientOf({ name: '@scope/agent_x 2', version: 'v1.0-beta' })).toEqual({ name: '@scope/agent_x 2', version: 'v1.0-beta' })
  })
  it('drops every character outside the kept set, control characters and non-ASCII included', () => {
    expect(mcpClientOf({ name: 'cur\u001b[31msor\n<b>"x"</b>', version: '1.0;rm -rf' })).toEqual({ name: 'cur31msorbx/b', version: '1.0rm -rf' })
    expect(mcpClientOf({ name: '클로드 code' })).toEqual({ name: 'code' })
  })
  it('cuts the name to 64 and the version to 32 characters', () => {
    const c = mcpClientOf({ name: 'n'.repeat(100), version: 'v'.repeat(100) })
    expect(c).toEqual({ name: 'n'.repeat(64), version: 'v'.repeat(32) })
  })
  it('drops a field with nothing left, and the whole client without a name', () => {
    expect(mcpClientOf({ name: 'x', version: '\u0000\u0001' })).toEqual({ name: 'x' })
    expect(mcpClientOf({ name: 'x', version: 7 })).toEqual({ name: 'x' })
    expect(mcpClientOf({ name: '\u0000한글', version: '1' })).toBeUndefined()
    expect(mcpClientOf({ name: '   ' })).toBeUndefined()
    for (const junk of [undefined, null, 'claude', 7, [], { version: '1' }, { name: 7 }]) expect(mcpClientOf(junk)).toBeUndefined()
  })
  it('actorOf puts the cleaned client on an mcp actor only', () => {
    const client = { name: 'claude-code', version: '1.2.3' }
    expect(actorOf({ sessionId: '', role: 'mcp', client, state: null })).toEqual({ surface: 'mcp', client })
    expect(actorOf({ sessionId: '', role: 'mcp', client: { name: 'a\nb' }, state: null })).toEqual({ surface: 'mcp', client: { name: 'ab' } })
    expect(actorOf({ sessionId: '', role: 'mcp', client: { name: '\n' }, state: null })).toEqual({ surface: 'mcp' })
    expect(actorOf({ sessionId: '', role: 'cli', client, state: null })).toEqual({ surface: 'cli' })
    expect(actorOf({ sessionId: '', role: 'app', client, state: null })).toEqual({ surface: 'desktop' })
  })
  it('round-trips through actor JSON', () => {
    const actor = actorOf({ sessionId: '', role: 'mcp', client: { name: 'claude-code', version: '1.2.3' }, state: null })
    expect(actorFromJson(JSON.stringify(actor))).toEqual({ surface: 'mcp', client: { name: 'claude-code', version: '1.2.3' } })
    expect(isJournalActor(actor)).toBe(true)
  })
  it('a client this build cannot read is dropped and the row still reads', () => {
    expect(actorFromJson('{"surface":"mcp","client":{"name":7}}')).toEqual({ surface: 'mcp' })
    expect(actorFromJson('{"surface":"mcp","client":"claude"}')).toEqual({ surface: 'mcp' })
    expect(actorFromJson('{"surface":"mcp","client":{"name":"a\\u001bb","version":"1"}}')).toEqual({ surface: 'mcp', client: { name: 'ab', version: '1' } })
    // Only mcp carries one: on another surface it is dropped.
    expect(actorFromJson('{"surface":"cli","client":{"name":"x"}}')).toEqual({ surface: 'cli' })
    expect(isJournalActor({ surface: 'mcp', client: { name: 7 } })).toBe(false)
    // Field by field, not by the order the keys were written in.
    expect(isJournalActor({ surface: 'mcp', client: { version: '1.2.3', name: 'claude-code' } })).toBe(true)
    expect(isJournalActor({ surface: 'mcp', client: { name: 'claude-code' } })).toBe(true)
    expect(isJournalActor({ surface: 'mcp', client: { name: 'a\nb' } })).toBe(false)
    expect(isJournalActor({ surface: 'mcp', client: { name: 'x', version: '' } })).toBe(false)
    expect(isJournalActor({ surface: 'cli', client: { name: 'x' } })).toBe(false)
  })
})

// MCP HTTP design §5: the address an MCP call came from over HTTP, stored as given (no lookups), on mcp only.
describe('the remote address on the actor', () => {
  it('actorOf puts the remote beside the client on an mcp actor only', () => {
    const client = { name: 'claude-code' }
    expect(actorOf({ sessionId: '', role: 'mcp', client, remote: '192.168.0.7', state: null })).toEqual({ surface: 'mcp', client, remote: '192.168.0.7' })
    expect(actorOf({ sessionId: '', role: 'mcp', remote: '::ffff:127.0.0.1', state: null })).toEqual({ surface: 'mcp', remote: '::ffff:127.0.0.1' })
    expect(actorOf({ sessionId: '', role: 'mcp', remote: 'fe80::1%eth0', state: null })).toEqual({ surface: 'mcp', remote: 'fe80::1%eth0' })
    expect(actorOf({ sessionId: '', role: 'cli', remote: '192.168.0.7', state: null })).toEqual({ surface: 'cli' })
    expect(actorOf({ sessionId: '', role: 'app', remote: '192.168.0.7', state: null })).toEqual({ surface: 'desktop' })
  })
  it('keeps only address characters, cut to 64, and drops one with nothing left', () => {
    expect(mcpRemoteOf('10.0.0.1\n<x>')).toBe('10.0.0.1x')
    expect(mcpRemoteOf('a'.repeat(100))).toBe('a'.repeat(64))
    for (const junk of [undefined, null, 7, '', ' \n', {}]) expect(mcpRemoteOf(junk)).toBeUndefined()
  })
  it('round-trips through actor JSON, and is dropped where it cannot be read', () => {
    const actor = actorOf({ sessionId: '', role: 'mcp', client: { name: 'c' }, remote: '10.0.0.2', state: null })
    expect(isJournalActor(actor)).toBe(true)
    expect(actorFromJson(JSON.stringify(actor))).toEqual({ surface: 'mcp', client: { name: 'c' }, remote: '10.0.0.2' })
    expect(actorFromJson('{"surface":"mcp","remote":7}')).toEqual({ surface: 'mcp' })
    expect(actorFromJson('{"surface":"cli","remote":"10.0.0.2"}')).toEqual({ surface: 'cli' })
    expect(isJournalActor({ surface: 'mcp', remote: '10.0.0.2' })).toBe(true)
    expect(isJournalActor({ surface: 'mcp', remote: 7 })).toBe(false)
    expect(isJournalActor({ surface: 'mcp', remote: 'a\nb' })).toBe(false)
    expect(isJournalActor({ surface: 'cli', remote: '10.0.0.2' })).toBe(false)
  })
})

describe('a controller (remote runtime design §2.5)', () => {
  it('is attributed to its client, never to the session it named', () => {
    const st = { ...emptyState(), runs: [{ coordinatorSessionId: 'ses-coord' }] } as unknown as OrchState
    expect(actorOf({ sessionId: 'ses-coord', role: 'controller', principal: { clientId: 'cli_ab12', name: 'laptop' }, state: st }))
      .toEqual({ surface: 'controller', controller: { clientId: 'cli_ab12', name: 'laptop' } })
  })
  it('reads back from journal JSON, and a controller field on another surface is refused', () => {
    const json = JSON.stringify({ surface: 'controller', controller: { clientId: 'cli_ab12', name: 'laptop' } })
    expect(actorFromJson(json)).toEqual({ surface: 'controller', controller: { clientId: 'cli_ab12', name: 'laptop' } })
    expect(isJournalActor({ surface: 'cli', controller: { clientId: 'cli_ab12', name: 'x' } })).toBe(false)
  })
  it('cleans what it keeps: a client id outside [A-Za-z0-9_-] is dropped', () => {
    expect(controllerOf({ clientId: 'cli ab;rm', name: 'laptop' })).toBeUndefined()
    expect(controllerOf({ clientId: 'cli_ab12', name: 'lap\ntop<script>' })).toEqual({ clientId: 'cli_ab12', name: 'laptopscript' })
  })
})
