// The words of a sandboxed start's warnings (Task E fix rounds 2 and 3), apart from startWarnings.ts so the renderer can
// read them: that module reads files and runs in main and the Host only. Type imports and catalog keys only.
import type { Message, MessageKey } from '../i18n'
import type { SandboxStartWarning } from '../types'

export const SANDBOX_WARNING_KEYS: Record<SandboxStartWarning, MessageKey> = {
  claudeUserns: 'session.sandbox.warn.claudeUserns',
  homeInWorkFolder: 'session.sandbox.warn.homeInWorkFolder'
}

/** The warnings a value names, in their fixed order, each once and only those this build knows: how a note's restore and
 *  any other value that crossed a process boundary is read. */
export function knownSandboxWarnings(v: unknown): SandboxStartWarning[] {
  if (!Array.isArray(v)) return []
  return (['claudeUserns', 'homeInWorkFolder'] as const).filter((w) => v.includes(w))
}

/** One message for a set of warnings: each alone, or both in one pair of sentences; null for none. What a chat's notice
 *  carries and what the line above a tab says. */
export function sandboxWarningMessage(ws: readonly SandboxStartWarning[]): Message | null {
  if (ws.length === 0) return null
  if (ws.length > 1) return { key: 'session.sandbox.warn.claudeUsernsAndHome' }
  return { key: SANDBOX_WARNING_KEYS[ws[0]] }
}

/** Whether a message is a start warning's: how the chat pane tells a warning notice from a refused roll's, which share
 *  the notice's wire shape (`{ key: 'rollRefused', reason }`). */
export const isSandboxWarningMessage = (m: Message): boolean => m.key.startsWith('session.sandbox.warn.')
