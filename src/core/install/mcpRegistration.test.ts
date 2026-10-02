import { describe, it, expect } from 'vitest'
import { mcpRegistrationLines, mcpServerFor, shimPathFor } from './mcpRegistration'
import { shuttleNames } from '../orchestration/exec/shuttle'

const WIN_SPACE = 'C:\\Users\\Jane Doe\\AppData\\Local\\astera\\bin\\astera.cmd'
const WIN_HANGUL = 'C:\\Users\\홍 길동\\AppData\\Local\\astera\\bin\\astera.cmd'
const WIN_SPECIAL = 'C:\\Users\\a&b (c)\\AppData\\Local\\astera\\bin\\astera.cmd'

describe('mcpRegistrationLines', () => {
  // On Windows the shim is astera.cmd, which a client that spawns without a shell cannot run, so each
  // line launches it through `cmd /c call` with the full path as its own argument (measured:
  // mcpRegistration.ts). `call` keeps the quotes when the folder name has `&` or parentheses.
  it.each([WIN_SPACE, WIN_HANGUL, WIN_SPECIAL])('win32 launches the full path through cmd /c call: %s', (shimPath) => {
    expect(mcpRegistrationLines({ platform: 'win32', shimPath })).toEqual([
      { client: 'Claude Code', line: `claude mcp add -s user astera -- cmd /c call "${shimPath}" mcp serve` },
      { client: 'Codex', line: `codex mcp add astera -- cmd /c call "${shimPath}" mcp serve` },
      {
        client: 'Cursor',
        line: JSON.stringify({ mcpServers: { astera: { command: 'cmd', args: ['/c', 'call', shimPath, 'mcp', 'serve'] } } })
      }
    ])
  })

  it('win32 Cursor JSON carries the path exactly once parsed', () => {
    const cursor = mcpRegistrationLines({ platform: 'win32', shimPath: WIN_HANGUL }).find((l) => l.client === 'Cursor')!
    expect(JSON.parse(cursor.line).mcpServers.astera.args[2]).toBe(WIN_HANGUL)
  })

  it.each(['darwin', 'linux'])('%s launches the full path, single-quoted for the shell', (platform) => {
    expect(mcpRegistrationLines({ platform, shimPath: '/Users/Jane Doe/.local/bin/astera' })).toEqual([
      { client: 'Claude Code', line: "claude mcp add -s user astera -- '/Users/Jane Doe/.local/bin/astera' mcp serve" },
      { client: 'Codex', line: "codex mcp add astera -- '/Users/Jane Doe/.local/bin/astera' mcp serve" },
      { client: 'Cursor', line: '{"mcpServers":{"astera":{"command":"/Users/Jane Doe/.local/bin/astera","args":["mcp","serve"]}}}' }
    ])
  })

  it('posix quoting survives a quote and non-ASCII in the path', () => {
    const lines = mcpRegistrationLines({ platform: 'linux', shimPath: "/home/홍 o'neil/.local/bin/astera" })
    expect(lines[0].line).toBe("claude mcp add -s user astera -- '/home/홍 o'\\''neil/.local/bin/astera' mcp serve")
    expect(JSON.parse(lines[2].line).mcpServers.astera.command).toBe("/home/홍 o'neil/.local/bin/astera")
  })

  it('the Cursor line is JSON a client can paste', () => {
    for (const [platform, shimPath] of [['win32', WIN_SPACE], ['darwin', '/a/astera'], ['linux', '/a/astera']]) {
      const cursor = mcpRegistrationLines({ platform, shimPath }).find((l) => l.client === 'Cursor')!
      expect(() => JSON.parse(cursor.line)).not.toThrow()
    }
  })

  // The Register buttons (mcpClients.ts) run this argv; it must be what the Cursor JSON carries.
  it.each([['win32', WIN_SPECIAL], ['linux', '/a b/astera']])('mcpServerFor is the Cursor entry on %s', (platform, shimPath) => {
    const cursor = mcpRegistrationLines({ platform, shimPath }).find((l) => l.client === 'Cursor')!
    expect(mcpServerFor({ platform, shimPath })).toEqual(JSON.parse(cursor.line).mcpServers.astera)
  })
})

describe('shimPathFor', () => {
  it('joins the install folder and the shim the shuttle writes first on this platform', () => {
    expect(shimPathFor({ platform: 'win32', dir: 'C:\\Users\\홍 길동\\AppData\\Local\\astera\\bin' })).toBe(WIN_HANGUL)
    expect(shimPathFor({ platform: 'win32', dir: 'C:\\Users\\홍 길동\\AppData\\Local\\astera\\bin\\' })).toBe(WIN_HANGUL)
    expect(shimPathFor({ platform: 'linux', dir: '/home/me/.local/bin' })).toBe('/home/me/.local/bin/astera')
    expect(shimPathFor({ platform: 'darwin', dir: '/Users/me/.local/bin/' })).toBe('/Users/me/.local/bin/astera')
  })

  // The renderer cannot import shuttle.ts (it reads the disk), so the name is written twice; this ties them.
  it.each(['win32', 'darwin', 'linux'] as const)('names the file shuttle.ts writes first on %s', (platform) => {
    const p = shimPathFor({ platform, dir: platform === 'win32' ? 'C:\\b' : '/b' })
    expect(p.split(/[\\/]/).at(-1)).toBe(shuttleNames(platform)[0])
  })
})
