// The tool call each session's Claude Code is waiting on, from the PreToolUse hook.
//
// Why a hook and not the transcript: Claude Code flushes nothing to the transcript while it waits for a
// person — measured in core/slack/transcript.ts's countToolUses comment — so while a question or an
// approval prompt is on screen, the call it is about exists nowhere but in this capture. slack.ts keeps
// the same capture for its own use (capturePendingTool); this one exists so the conversation view can
// draw the question as a form (core/prompts/askUserQuestion.ts) instead of reading the screen for it.
//
// Same rules as slack.ts, deliberately: the latest PreToolUse wins (Claude Code batches calls, and the
// last one issued is the one whose prompt is up); the PostToolUse with the same id ends it; Stop (or
// StopFailure, the turn end of an API error) ends it whatever the id (a declined question runs no tool,
// so its PostToolUse can be missed); a session's exit
// forgets it. Fed by the hook fan-out (hookFanOut.ts), read over IPC (ipc.ts: `conversation.pendingPrompt`
// and the `conversation:pendingPrompt` push).
import type { PendingToolPrompt } from '../core/types'

export interface PendingPromptState {
  /** One hook event for one session — the raw payload, as every other fan-out tap receives it. */
  onHookEvent(sessionId: string, payload: unknown): void
  /** The session ended; forget it. */
  forget(sessionId: string): void
  get(sessionId: string): PendingToolPrompt | null
  /** Fires only when a session's capture actually changes (set, replaced by a different call, cleared).
   *  Returns an unsubscribe. */
  subscribe(fn: (sessionId: string, prompt: PendingToolPrompt | null) => void): () => void
}

export function createPendingPromptState(now: () => number = Date.now): PendingPromptState {
  const sessions = new Map<string, PendingToolPrompt>()
  const listeners = new Set<(sessionId: string, prompt: PendingToolPrompt | null) => void>()

  function set(sessionId: string, next: PendingToolPrompt | null): void {
    const prev = sessions.get(sessionId) ?? null
    if (prev === null && next === null) return
    if (prev !== null && next !== null && prev.toolUseId === next.toolUseId) return
    if (next === null) sessions.delete(sessionId)
    else sessions.set(sessionId, next)
    for (const fn of listeners) fn(sessionId, next)
  }

  return {
    onHookEvent(sessionId, payload) {
      if (typeof payload !== 'object' || payload === null) return
      const p = payload as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown }
      if (p.hook_event_name === 'PreToolUse') {
        if (typeof p.tool_name !== 'string' || typeof p.tool_use_id !== 'string') return
        if (typeof p.tool_input !== 'object' || p.tool_input === null) return
        set(sessionId, { toolUseId: p.tool_use_id, tool: p.tool_name, input: p.tool_input, at: now() })
      } else if (p.hook_event_name === 'PostToolUse') {
        const current = sessions.get(sessionId)
        if (current !== undefined && current.toolUseId === p.tool_use_id) set(sessionId, null)
      } else if (p.hook_event_name === 'Stop' || p.hook_event_name === 'StopFailure') {
        // StopFailure fires instead of Stop when an API error ends the turn; no question of it is on
        // screen after that either. It is captured async and can land after the next turn's
        // PreToolUse; see attention.ts for that window and why it is accepted.
        set(sessionId, null)
      }
    },
    forget(sessionId) {
      set(sessionId, null)
    },
    get(sessionId) {
      return sessions.get(sessionId) ?? null
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}
