// What observe mode's actions and coverage notes are called where a person reads them (design §11): one table of message
// keys that Settings › Security & Access says in the person's language and the CLI's `--human` output says in English,
// so the two never name the same call differently. Never the action's own name (`git.remote.write`). A rule's groups and
// the coverage rows' session kinds live here too, so a finding's reason names a coverage gap as Policies does (lifecycle
// design §4.6).
import type { MessageKey } from '../i18n'
import type { AuditAction, CoverageNote, CoverageRow } from './types'

/** A record, so the compiler holds it to the resolver's list: an action missing here fails to build. */
export const ACTION_PHRASES: Record<AuditAction, MessageKey> = {
  'process.execute': 'audit.action.process.execute',
  'git.read': 'audit.action.git.read',
  'git.local.write': 'audit.action.git.local.write',
  'git.remote.write': 'audit.action.git.remote.write',
  'github.pr.create': 'audit.action.github.pr.create',
  'github.write': 'audit.action.github.write',
  'package.install': 'audit.action.package.install',
  'filesystem.read': 'audit.action.filesystem.read',
  'filesystem.write': 'audit.action.filesystem.write',
  'filesystem.delete': 'audit.action.filesystem.delete',
  'network.request': 'audit.action.network.request',
  'mcp.call': 'audit.action.mcp.call',
  'agent.spawn': 'audit.action.agent.spawn',
  other: 'audit.action.other'
}

export const COVERAGE_NOTE_PHRASES: Record<CoverageNote, MessageKey> = {
  'web-tools-only': 'audit.coverageNote.web-tools-only',
  'shell-text-only': 'audit.coverageNote.shell-text-only',
  'web-search-and-shell-text': 'audit.coverageNote.web-search-and-shell-text',
  'interactive-input': 'audit.coverageNote.interactive-input',
  'runtime-measured': 'audit.coverageNote.runtime-measured',
  'file-tools-only': 'audit.coverageNote.file-tools-only',
  'bus-path-only': 'audit.coverageNote.bus-path-only'
}

/** The groups of actions a rule can name with a trailing `*`, said in words. Another pattern is shown as it is. */
export const ACTION_GROUP_PHRASES: Record<string, MessageKey> = {
  'git.*': 'settings.security.group.git',
  'github.*': 'settings.security.group.github',
  'filesystem.*': 'settings.security.group.filesystem',
  '*': 'settings.security.group.all'
}

/** The key that says an action or a rule's pattern: its phrase, its group's, or null for a pattern with no words, which
 *  is shown as it was named. Settings and a finding's reason (lifecycle design §4.6) say a rule's action alike. */
export function actionPhraseKey(action: string): MessageKey | null {
  if (Object.hasOwn(ACTION_PHRASES, action)) return ACTION_PHRASES[action as AuditAction]
  if (Object.hasOwn(ACTION_GROUP_PHRASES, action)) return ACTION_GROUP_PHRASES[action]
  return null
}

/** The kind of session a coverage row is for. */
export const SESSION_KIND_PHRASES: Record<CoverageRow['kind'], MessageKey> = {
  terminal: 'settings.security.kind.terminal',
  chat: 'settings.security.kind.chat'
}
