// What each shared skill and agent's canonical copy says of itself (lifecycle design §4.12): read from the frontmatter of
// the copies under extensionPaths, so the findings can match a use Claude Code reported to the registry entry it was. A
// skill is called by its folder or its frontmatter `name`, an agent only by its frontmatter `name` (its file's name when it
// has none); an agent's `skills:` and a skill's `agent:` name items Claude Code may use with no event at all.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import type { ExtensionCopy, ExtensionEntry } from './types'

/** A frontmatter value as written: a comment after it and its quotes taken off. */
function scalar(raw: string): string {
  let v = raw.trim()
  if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, '')
  else {
    const end = v.indexOf(v[0], 1)
    if (end > 0) v = v.slice(1, end)
  }
  return v.trim()
}

/** A list written on the key's own line: `[a, b]` or `a, b`. */
const inlineList = (raw: string): string[] => {
  const v = raw.trim().replace(/\s+#.*$/, '')
  const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v
  return inner.split(',').map(scalar).filter((x) => x !== '')
}

/**
 * The `name`, `skills` and `agent` of a markdown frontmatter block (§4.12). Not a YAML parser, as the composer's menu reads
 * a description (core/commands/slashCommands.ts): a name is one line, and `skills:` is written inline or as a block list of
 * one name per line, as Claude Code's own docs write it (sub-agents, "Preload skills into subagents"). Nothing after the
 * block is read.
 */
export function copyFrontmatter(text: string): ExtensionCopy {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out: ExtensionCopy = {}
  let list: string[] | null = null
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    if (list !== null) {
      const item = /^\s*-\s*(.*)$/.exec(line)
      if (item) {
        const v = scalar(item[1])
        if (v !== '') list.push(v)
        continue
      }
      if (line.trim() === '') continue
      list = null
    }
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line)
    if (!m) continue
    if (m[1] === 'name' || m[1] === 'agent') {
      const v = scalar(m[2])
      if (v !== '') out[m[1]] = v
    } else if (m[1] === 'skills') {
      if (m[2].trim() === '') list = out.skills = []
      else out.skills = inlineList(m[2])
    }
  }
  return out
}

/** What each shared skill and agent's canonical copy says of itself, by entry id: a skill's `SKILL.md` and an agent's
 *  `<name>.md`. A command is named by its file alone, so none is read. A copy that cannot be read is left out, and the
 *  findings then do not judge that item, nor what it might name. Never rejects. */
export async function readExtensionCopies(profileDir: string, entries: readonly ExtensionEntry[]): Promise<Map<string, ExtensionCopy>> {
  const paths = extensionPaths(profileDir)
  const out = new Map<string, ExtensionCopy>()
  for (const e of entries) {
    if (e.kind !== 'skill' && e.kind !== 'agent') continue
    const file = e.kind === 'skill' ? path.join(paths.skills, e.name, 'SKILL.md') : path.join(paths.agents, `${e.name}.md`)
    try {
      out.set(e.id, copyFrontmatter(await fs.readFile(file, 'utf8')))
    } catch {
      // Not there or not readable: what it is called is not known
    }
  }
  return out
}
