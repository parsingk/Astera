// The use log of shared skills, commands and agents (lifecycle design §4.12): while Observe is on, the Host's recorder
// appends each use Claude Code reported exactly (research cli-use-reporting.md §1) to day files of their own beside the
// tool calls, kept as long and as large as those are (the audit store's own machinery, audit/store.ts). A use holds the
// name the CLI reported and whose session it was, never a prompt or a command's arguments. The findings read back only
// which names were used in the window (summarizeExtensionUses), and match them to the registry by what each canonical
// copy says it is called (readExtensionCopies).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths, profilePaths } from '../profile/paths'
import { appendDated, visitDaysIn, type AuditStoreOptions } from './store'
import type { ExtensionEntry } from '../extensions/types'
import type { ExtensionCopy, ExtensionUseSummary } from '../findings/types'

// Declared beside the other findings shapes the renderer reads (findings/types.ts), kept importable from here
export type { ExtensionCopy, ExtensionUseSummary } from '../findings/types'

/** One use a CLI reported exactly (§4.12). Never a prompt, never arguments. */
export interface ExtensionUse {
  id: string // 'eu_' + 16 hex
  at: string
  sessionId: string
  provider: 'claude'
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** skill-tool: the Skill tool's `skill`; slash: UserPromptExpansion's `command_name`; subagent: SubagentStart's
   *  `agent_type`; agent-tool: a chat stream's Agent tool `subagent_type`. */
  via: 'skill-tool' | 'slash' | 'subagent' | 'agent-tool'
  name: string
}

const VIA: ReadonlySet<string> = new Set<ExtensionUse['via']>(['skill-tool', 'slash', 'subagent', 'agent-tool'])
const STRINGS = ['id', 'at', 'sessionId', 'name'] as const
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A line the Host wrote, with its time parsed once; null for anything else. */
function useOf(line: string): { r: ExtensionUse; at: number } | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || !STRINGS.every((k) => typeof v[k] === 'string') || typeof v.via !== 'string' || !VIA.has(v.via)) return null
  const at = Date.parse(v.at as string)
  return Number.isFinite(at) ? { r: v as unknown as ExtensionUse, at } : null
}

/** Appends the uses to their days' files. Never throws. */
export function appendExtensionUses(profileDir: string, uses: readonly ExtensionUse[], o: AuditStoreOptions = {}): Promise<void> {
  return appendDated(profilePaths(profileDir).extensionUses, uses, o, 'extension uses')
}

/** The names used from `sinceMs` on, as reported, read in one pass that keeps only the names. A folder that is not there
 *  is no use at all; one that cannot be read rejects, so the findings name the source as unread rather than take every
 *  item for unused. `nowMs` is the read's clock, for the days kept. */
export async function summarizeExtensionUses(profileDir: string, sinceMs: number, nowMs: number): Promise<ExtensionUseSummary> {
  const s: ExtensionUseSummary = { skillOrCommand: new Set(), agents: new Set() }
  await visitDaysIn(
    profilePaths(profileDir).extensionUses,
    useOf,
    () => true,
    { since: new Date(sinceMs).toISOString() },
    (u) => void (u.via === 'skill-tool' || u.via === 'slash' ? s.skillOrCommand : s.agents).add(u.name),
    () => false,
    { now: () => nowMs }
  )
  return s
}

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
 * The `name` and `skills` of a markdown frontmatter block (§4.12). Not a YAML parser, as the composer's menu reads a
 * description (core/commands/slashCommands.ts): a skill's or agent's name is one line, and `skills:` is written inline or
 * as a block list of one name per line, as Claude Code's own docs write it (sub-agents, "Preload skills into subagents").
 * Nothing after the block is read.
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
    if (m[1] === 'name') {
      const v = scalar(m[2])
      if (v !== '') out.name = v
    } else if (m[1] === 'skills') {
      if (m[2].trim() === '') list = out.skills = []
      else out.skills = inlineList(m[2])
    }
  }
  return out
}

/** What each shared skill and agent's canonical copy says it is called, by entry id: a skill's `SKILL.md` and an agent's
 *  `<name>.md`. A command is named by its file alone, so none is read. A copy that cannot be read is left out, and the
 *  findings then do not judge that item, nor, for an agent, any skill it might preload. Never rejects. */
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
