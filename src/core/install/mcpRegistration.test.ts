import { describe, it, expect } from 'vitest'
import { mcpRegistrationLines } from './mcpRegistration'

describe('mcpRegistrationLines', () => {
  // On Windows `astera` is astera.cmd, which a client that spawns without a shell cannot run (docs/mcp.md).
  it('win32 launches through cmd /c', () => {
    expect(mcpRegistrationLines('win32')).toEqual([
      { client: 'Claude Code', line: 'claude mcp add astera -- cmd /c astera mcp serve' },
      { client: 'Codex', line: 'codex mcp add astera -- cmd /c astera mcp serve' },
      { client: 'Cursor', line: '{"mcpServers":{"astera":{"command":"cmd","args":["/c","astera","mcp","serve"]}}}' }
    ])
  })

  it.each(['darwin', 'linux'])('%s launches astera directly', (platform) => {
    expect(mcpRegistrationLines(platform)).toEqual([
      { client: 'Claude Code', line: 'claude mcp add astera -- astera mcp serve' },
      { client: 'Codex', line: 'codex mcp add astera -- astera mcp serve' },
      { client: 'Cursor', line: '{"mcpServers":{"astera":{"command":"astera","args":["mcp","serve"]}}}' }
    ])
  })

  it('the Cursor line is JSON a client can paste', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const cursor = mcpRegistrationLines(platform).find((l) => l.client === 'Cursor')!
      expect(() => JSON.parse(cursor.line)).not.toThrow()
    }
  })
})
