// What observe mode's actions and coverage notes are called where a person reads them (design §11): one table of message
// keys that Settings › Security & Access says in the person's language and the CLI's `--human` output says in English,
// so the two never name the same call differently. Never the action's own name (`git.remote.write`).
import type { MessageKey } from '../i18n'
import type { AuditAction, CoverageNote } from './types'

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
  'interactive-input': 'audit.coverageNote.interactive-input'
}
