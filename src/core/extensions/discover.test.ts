// Agent Control Plane release 1 (design §4.4, Review Focus 2): what a default account could share, by name only. The
// ambient Claude account keeps its user-scope MCP servers in <home>/.claude.json; values are never read here.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { discoverIn } from './discover'
import type { Account } from '../types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-discover-'))
  dirs.push(d)
  return d
}
const account = (configDir: string, provider: 'claude' | 'codex' = 'claude'): Account => ({
  id: 'acc_1', label: 'a', configDir, color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider
})
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const SECRET = 'ghp_value_that_must_not_appear_000000000'
const EMPTY = { version: 1 as const, entries: [] }

describe('discoverIn', () => {
  it('reads the ambient Claude account from <home>/.claude.json and an isolated one from its own folder', async () => {
    const home = await temp()
    const ambient = path.join(home, '.claude')
    await write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { home: { command: 'npx', args: ['h'] } } }))
    await write(path.join(ambient, '.claude.json'), JSON.stringify({ mcpServers: { wrong: { command: 'x' } } }))
    const a = await discoverIn({ account: account(ambient), homeDir: home, registry: EMPTY })
    expect(a.filter((d) => d.kind === 'mcp').map((d) => d.name)).toEqual(['home'])

    const isolated = path.join(home, '.claude-accounts', 'b')
    await write(path.join(isolated, '.claude.json'), JSON.stringify({ mcpServers: { own: { command: 'y' } } }))
    const b = await discoverIn({ account: account(isolated), homeDir: home, registry: EMPTY })
    expect(b.filter((d) => d.kind === 'mcp').map((d) => d.name)).toEqual(['own'])
  })

  it('lists Claude skills, commands and agents, leaving out Astera’s own', async () => {
    const home = await temp()
    const dir = path.join(home, '.claude-accounts', 'c')
    await write(path.join(dir, 'skills', 'review', 'SKILL.md'), 's')
    await write(path.join(dir, 'skills', 'astera-orchestration', 'SKILL.md'), 's')
    await write(path.join(dir, 'commands', 'ship.md'), 'c')
    await write(path.join(dir, 'agents', 'tester.md'), 'a')
    await write(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { astera: { command: 'astera' } } }))
    const found = await discoverIn({ account: account(dir), homeDir: home, registry: EMPTY })
    const shareable = found.filter((d) => d.shareable).map((d) => `${d.kind}:${d.name}`).sort()
    expect(shareable).toEqual(['agent:tester', 'command:ship', 'skill:review'])
    expect(found.filter((d) => !d.shareable).map((d) => [d.name, d.shareable === false ? d.reason : null]).sort()).toEqual([
      ['astera', 'astera-own'],
      ['astera-orchestration', 'astera-own']
    ])
  })

  it('reads Codex servers by name and environment names only', async () => {
    const home = await temp()
    const dir = path.join(home, '.codex')
    await write(
      path.join(dir, 'config.toml'),
      ['model = "m"', '[mcp_servers.gh]', 'command = "npx"', 'args = ["gh-mcp"]', '[mcp_servers.gh.env]', `GITHUB_TOKEN = "${SECRET}"`, 'LOG_LEVEL = "info"', ''].join('\n')
    )
    await write(path.join(dir, 'skills', 'plan', 'SKILL.md'), 's')
    const found = await discoverIn({ account: account(dir, 'codex'), homeDir: home, registry: EMPTY })
    expect(JSON.stringify(found)).not.toContain(SECRET)
    const gh = found.find((d) => d.name === 'gh')!
    expect(gh.mcp).toMatchObject({ transport: 'stdio', command: 'npx', args: ['gh-mcp'], envNames: ['GITHUB_TOKEN', 'LOG_LEVEL'] })
    expect(gh.warnings).toEqual(['session-tools'])
    expect(found.map((d) => `${d.kind}:${d.name}`).sort()).toEqual(['mcp:gh', 'skill:plan'])
  })

  it('marks a server that needs a CLI-steering name, or a secret header, as not shareable', async () => {
    const home = await temp()
    const dir = path.join(home, '.claude-accounts', 'd')
    await write(
      path.join(dir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          llm: { command: 'x', env: { OPENAI_API_KEY: SECRET } },
          remote: { type: 'http', url: 'https://mcp.example', headers: { Authorization: `Bearer ${SECRET}` } }
        }
      })
    )
    const found = await discoverIn({ account: account(dir), homeDir: home, registry: EMPTY })
    expect(JSON.stringify(found)).not.toContain(SECRET)
    expect(found.map((d) => [d.name, d.shareable ? null : d.reason]).sort()).toEqual([
      ['llm', 'cli-env-name'],
      ['remote', 'header-secret']
    ])
  })

  it('leaves out what is already shared', async () => {
    const home = await temp()
    const dir = path.join(home, '.claude-accounts', 'e')
    await write(path.join(dir, 'skills', 'review', 'SKILL.md'), 's')
    const registry = {
      version: 1 as const,
      entries: [{ id: 'skill-review', kind: 'skill' as const, name: 'review', hash: 'sha256:x', providers: ['claude' as const], importedFrom: 'acc_9', enabled: true }]
    }
    expect(await discoverIn({ account: account(dir), homeDir: home, registry })).toEqual([])
  })
})
