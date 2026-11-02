// What a shared plugin brings, read from its install folder for the settings row (Claude plugin sharing design §5.9): its
// skills, commands, agents and MCP servers by name, and whether it has hooks. It only reads, and a part that is missing,
// cannot be read or has another shape is empty, never an error: the plugin list answers whatever a folder holds.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ClaudePluginContents } from './types'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

const namesIn = (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => [])
const isFile = (file: string): Promise<boolean> => fs.stat(file).then((s) => s.isFile(), () => false)

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** The folders in `dir` that hold a `SKILL.md`, sorted. */
async function skillsIn(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await namesIn(dir)) if (await isFile(path.join(dir, name, 'SKILL.md'))) out.push(name)
  return out.sort()
}

/** The `.md` files in `dir`, by name without the extension, sorted. */
async function markdownIn(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await namesIn(dir)) if (name.length > 3 && name.endsWith('.md') && (await isFile(path.join(dir, name)))) out.push(name.slice(0, -3))
  return out.sort()
}

/** The servers of a map from server name to its settings: the keys whose value is an object. */
const serverNames = (map: unknown): string[] => (isObj(map) ? Object.keys(map).filter((k) => isObj(map[k])) : [])

export async function readClaudePluginContents(installPath: string): Promise<ClaudePluginContents> {
  const [skills, commands, agents, mcp, manifest, hooks] = await Promise.all([
    skillsIn(path.join(installPath, 'skills')),
    markdownIn(path.join(installPath, 'commands')),
    markdownIn(path.join(installPath, 'agents')),
    readJson(path.join(installPath, '.mcp.json')),
    readJson(path.join(installPath, '.claude-plugin', 'plugin.json')),
    isFile(path.join(installPath, 'hooks', 'hooks.json'))
  ])
  // `.mcp.json` holds `{ mcpServers: {...} }`, or is the servers map itself
  const fromFile = isObj(mcp) && 'mcpServers' in mcp ? serverNames(mcp.mcpServers) : serverNames(mcp)
  // A manifest's `mcpServers` may name a file instead of holding the servers; only the object form is read
  const fromManifest = isObj(manifest) ? serverNames(manifest.mcpServers) : []
  return { skills, commands, agents, mcpServers: [...new Set([...fromFile, ...fromManifest])].sort(), hooks }
}
