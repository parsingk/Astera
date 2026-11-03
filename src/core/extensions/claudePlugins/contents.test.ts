// What a shared plugin brings, read from its install folder for the settings row (Claude plugin sharing design §5.9).
// Plugin folders here are temp folders with hand-written files; a part that is missing or damaged reads as empty.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { readClaudePluginContents } from './contents'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-claudeplugin-contents-'))
  dirs.push(d)
  return d
}
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const NOTHING = { skills: [], commands: [], agents: [], mcpServers: [], hooks: false }

describe('readClaudePluginContents', () => {
  it('names the skills, commands, agents and MCP servers a plugin folder holds, and whether it has hooks', async () => {
    const dir = await temp()
    await write(path.join(dir, 'skills', 'review', 'SKILL.md'), '# review')
    await write(path.join(dir, 'skills', 'brainstorm', 'SKILL.md'), '# brainstorm')
    // A folder without SKILL.md, and a file, are not skills
    await write(path.join(dir, 'skills', 'drafts', 'notes.md'), 'x')
    await write(path.join(dir, 'skills', 'README.md'), 'x')
    await write(path.join(dir, 'commands', 'ship.md'), 'x')
    await write(path.join(dir, 'commands', 'plan.md'), 'x')
    await write(path.join(dir, 'commands', 'notes.txt'), 'x')
    await write(path.join(dir, 'agents', 'reviewer.md'), 'x')
    await write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx' }, sentry: { url: 'https://x' } } }))
    await write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', mcpServers: { github: { command: 'gh' }, linear: { command: 'npx' } } }))
    await write(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }))
    expect(await readClaudePluginContents(dir)).toEqual({
      skills: ['brainstorm', 'review'],
      commands: ['plan', 'ship'],
      agents: ['reviewer'],
      mcpServers: ['github', 'linear', 'sentry'],
      hooks: true
    })
  })

  it('reads an .mcp.json that is the servers map itself', async () => {
    const dir = await temp()
    await write(path.join(dir, '.mcp.json'), JSON.stringify({ $schema: 'https://example.test/schema.json', notion: { url: 'https://x' } }))
    expect((await readClaudePluginContents(dir)).mcpServers).toEqual(['notion'])
  })

  it('reads a folder that is gone, and parts that are damaged or of another shape, as empty', async () => {
    const dir = await temp()
    expect(await readClaudePluginContents(path.join(dir, 'gone'))).toEqual(NOTHING)
    await write(path.join(dir, '.mcp.json'), '{ not json')
    // A manifest may name a file of servers rather than hold them
    await write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', mcpServers: './servers.json' }))
    // A hooks folder without hooks.json
    await write(path.join(dir, 'hooks', 'run.sh'), 'x')
    expect(await readClaudePluginContents(dir)).toEqual(NOTHING)
  })
})
