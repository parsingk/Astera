// The use log of shared skills, commands and agents (lifecycle design §4.12): while Observe is on, the Host's recorder
// appends each use Claude Code reported exactly (research cli-use-reporting.md §1), and the mark of each Claude chat that
// ran (ruling R6-1) and of each Claude terminal session that ran without the use hooks (ruling R6-8), to day files of their
// own beside the tool calls, kept as long and as large as those are (the audit store's own machinery, audit/store.ts). A
// use holds the name the CLI reported and whose session it was, never a prompt or a command's arguments. The findings read
// back only which names were used in the window, and whether such a session ran (summarizeExtensionUses); what each
// registry entry is called is the extensions' to say (extensions/copies.ts).
import { profilePaths } from '../profile/paths'
import { appendDated, visitDaysIn, type AuditStoreOptions } from './store'
import type { ExtensionUseSummary } from './types'

// Declared beside the other shapes the renderer reads (types.ts), kept importable from here
export type { ExtensionUseSummary } from './types'

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
   *  `agent_type`; agent-tool: a chat stream's Agent tool `subagent_type`. chat-seen: no use, the mark of a Claude chat that
   *  ran, whose typed skills and commands are not reported (ruling R6-1). unhooked: no use, the mark of a Claude terminal
   *  session that ran without the hooks that report them, written each local day it runs (ruling R6-8). A mark's name is
   *  empty. */
  via: 'skill-tool' | 'slash' | 'subagent' | 'agent-tool' | 'chat-seen' | 'unhooked'
  name: string
}

const VIA: ReadonlySet<string> = new Set<ExtensionUse['via']>(['skill-tool', 'slash', 'subagent', 'agent-tool', 'chat-seen', 'unhooked'])
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

/** The names used from `sinceMs` on, as reported, and whether a Claude chat, or a Claude session without the use hooks,
 *  ran, read in one pass that keeps only those. A folder that is not there is no use at all; one that cannot be read
 *  rejects, so the findings name the source as unread rather than take every item for unused. `nowMs` is the read's
 *  clock, for the days kept. */
export async function summarizeExtensionUses(profileDir: string, sinceMs: number, nowMs: number): Promise<ExtensionUseSummary> {
  const s: ExtensionUseSummary = { skillOrCommand: new Set(), agents: new Set(), claudeChatSeen: false, claudeUnhookedSeen: false }
  await visitDaysIn(
    profilePaths(profileDir).extensionUses,
    useOf,
    () => true,
    { since: new Date(sinceMs).toISOString() },
    (u) => {
      if (u.via === 'chat-seen') s.claudeChatSeen = true
      else if (u.via === 'unhooked') s.claudeUnhookedSeen = true
      else (u.via === 'skill-tool' || u.via === 'slash' ? s.skillOrCommand : s.agents).add(u.name)
    },
    () => false,
    { now: () => nowMs }
  )
  return s
}
