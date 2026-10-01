import { describe, it, expect } from 'vitest'
import { mcpRefusal, MCP_READ_COMMANDS, MCP_CONTROL_COMMANDS } from './mcpGate'

describe('mcpRefusal', () => {
  it('off refuses every command and names the setting', () => {
    const r = mcpRefusal('jobs-list', 'off')
    expect(r?.status).toBe(403)
    expect(r?.body.error).toMatch(/MCP access/)
  })
  it('read admits the reads and refuses the mutations', () => {
    for (const cmd of MCP_READ_COMMANDS) expect(mcpRefusal(cmd, 'read')).toBeNull()
    for (const cmd of MCP_CONTROL_COMMANDS) expect(mcpRefusal(cmd, 'read')?.status).toBe(403)
  })
  it('control admits both lists', () => {
    for (const cmd of [...MCP_READ_COMMANDS, ...MCP_CONTROL_COMMANDS]) expect(mcpRefusal(cmd, 'control')).toBeNull()
  })
  it('runs-resume is a control command: stop_run has its way back', () => {
    expect(mcpRefusal('runs-resume', 'control')).toBeNull()
    expect(mcpRefusal('runs-resume', 'read')?.status).toBe(403)
  })
  it('refuses everything else whatever the setting', () => {
    for (const cmd of ['worker-start', 'sessions-send', 'chats-answer', 'state-put', 'run-delete', 'tasks-add', 'run-resume'])
      expect(mcpRefusal(cmd, 'control')?.status).toBe(403)
  })
})
