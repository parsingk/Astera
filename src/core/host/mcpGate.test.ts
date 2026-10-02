import { describe, it, expect } from 'vitest'
import { mcpRefusal, MCP_READ_COMMANDS, MCP_CONTROL_COMMANDS, MCP_SESSION_READ_COMMANDS, MCP_SESSION_WRITE_COMMANDS } from './mcpGate'

describe('mcpRefusal', () => {
  it('off refuses every command and names the setting', () => {
    const r = mcpRefusal('jobs-list', 'off', false)
    expect(r?.status).toBe(403)
    expect(r?.body.error).toMatch(/MCP access/)
  })
  it('read admits the reads and refuses the mutations', () => {
    for (const cmd of MCP_READ_COMMANDS) expect(mcpRefusal(cmd, 'read', false)).toBeNull()
    for (const cmd of MCP_CONTROL_COMMANDS) expect(mcpRefusal(cmd, 'read', false)?.status).toBe(403)
  })
  it('control admits both lists', () => {
    for (const cmd of [...MCP_READ_COMMANDS, ...MCP_CONTROL_COMMANDS]) expect(mcpRefusal(cmd, 'control', false)).toBeNull()
  })
  it('runs-resume is a control command: stop_run has its way back', () => {
    expect(mcpRefusal('runs-resume', 'control', false)).toBeNull()
    expect(mcpRefusal('runs-resume', 'read', false)?.status).toBe(403)
  })
  it('tasks-add is a control command and run-configs-list a read: create_task and list_run_configs', () => {
    expect(mcpRefusal('tasks-add', 'control', false)).toBeNull()
    expect(mcpRefusal('tasks-add', 'read', false)?.status).toBe(403)
    expect(mcpRefusal('run-configs-list', 'read', false)).toBeNull()
  })
  it('tasks-check-output and tasks-output are reads: get_check_output and get_task_output', () => {
    for (const cmd of ['tasks-check-output', 'tasks-output']) expect(mcpRefusal(cmd, 'read', false)).toBeNull()
  })
  it('refuses everything else whatever the setting', () => {
    for (const sessions of [false, true])
      for (const cmd of ['worker-start', 'chats-answer', 'state-put', 'run-delete', 'task-create', 'run-configs', 'run-resume'])
        expect(mcpRefusal(cmd, 'control', sessions)?.status).toBe(403)
  })

  describe('session commands', () => {
    it('the lists are the four session commands', () => {
      expect([...MCP_SESSION_READ_COMMANDS]).toEqual(['sessions-list', 'sessions-read'])
      expect([...MCP_SESSION_WRITE_COMMANDS]).toEqual(['sessions-send', 'sessions-create'])
    })
    it('access off refuses every session command whatever mcpSessions says', () => {
      for (const sessions of [false, true])
        for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create'])
          expect(mcpRefusal(cmd, 'off', sessions)?.body.error).toMatch(/MCP access is off/)
    })
    it('mcpSessions off refuses all four and names the setting', () => {
      for (const access of ['read', 'control'] as const)
        for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create']) {
          const r = mcpRefusal(cmd, access, false)
          expect(r?.status).toBe(403)
          expect(r?.body.error).toMatch(/Let MCP clients see and use sessions/)
          expect(r?.body.error).toMatch(/CLI tab/)
        }
    })
    it('mcpSessions on + read admits the session reads and refuses the writes', () => {
      expect(mcpRefusal('sessions-list', 'read', true)).toBeNull()
      expect(mcpRefusal('sessions-read', 'read', true)).toBeNull()
      for (const cmd of ['sessions-send', 'sessions-create']) {
        const r = mcpRefusal(cmd, 'read', true)
        expect(r?.status).toBe(403)
        expect(r?.body.error).toMatch(/Read and control/)
      }
    })
    it('mcpSessions on + control admits all four', () => {
      for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create'])
        expect(mcpRefusal(cmd, 'control', true)).toBeNull()
    })
    it('mcpSessions on does not open the other commands', () => {
      for (const cmd of ['worker-start', 'jobs-list-x', 'sessions-delete'])
        expect(mcpRefusal(cmd, 'control', true)?.status).toBe(403)
      expect(mcpRefusal('jobs-list', 'read', false)).toBeNull()
    })
  })
})
