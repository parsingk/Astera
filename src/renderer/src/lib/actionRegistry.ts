// The registry every UI action runs through: the global shortcuts, the command palette, and later actions plugins
// contribute (knowledge/decisions/ADR-007). The list of actions — ids, default chords, wording — is ACTIONS in
// core/keys/binding.ts; this holds only who answers each one and how.
//
// A handler belongs to an owner: 'core', or a plugin's id for the commands it contributes (Phase 2, ADR-008), which are
// held under their contribution key (`<plugin id>:<command id>`), never a core id. Registering an id that already has a handler is
// refused rather than replacing it: two parts of the app claiming one action is a bug to see at once, not a race
// whose winner depends on mount order. An id with no handler is reported blocked, not hidden, so a missing handler
// shows up as a row that says so instead of a key that silently does nothing.

import type { ActionId } from '../../../core/keys/binding'
import type { MessageKey } from '../../../core/i18n'
import type { ContributionKey } from '../../../core/plugins/manifest'

/** A core action's id, or a plugin command's contribution key. */
export type RegistryId = ActionId | ContributionKey

export type ActionHandler = {
  /** Why the action cannot run right now, as an i18n key, or null when it can. Asked at the moment of each call,
   *  so it reads the state as it is then. Omitted: the action can always run. */
  blockedBy?: () => MessageKey | null
  run: () => void
}

export type ActionState = { ok: true } | { ok: false; reason: MessageKey }

export type ActionRegistry = {
  /** Returns a disposer that removes this registration only (a later one for the same id survives it). */
  register(owner: string, id: RegistryId, handler: ActionHandler): () => void
  disposeOwner(owner: string): void
  state(id: RegistryId): ActionState
  /** Runs the action when it can run; returns the state it found either way. */
  run(id: RegistryId): ActionState
}

type Entry = { owner: string; handler: ActionHandler }

export function createActionRegistry(): ActionRegistry {
  const entries = new Map<RegistryId, Entry>()

  const state = (id: RegistryId): ActionState => {
    const entry = entries.get(id)
    if (!entry) return { ok: false, reason: 'action.blocked.noHandler' }
    const reason = entry.handler.blockedBy?.() ?? null
    return reason === null ? { ok: true } : { ok: false, reason }
  }

  return {
    register(owner, id, handler) {
      const existing = entries.get(id)
      if (existing) throw new Error(`action ${id} already has a handler (owner ${existing.owner}); ${owner} cannot register it`)
      const entry: Entry = { owner, handler }
      entries.set(id, entry)
      return () => {
        if (entries.get(id) === entry) entries.delete(id)
      }
    },
    disposeOwner(owner) {
      for (const [id, entry] of entries) if (entry.owner === owner) entries.delete(id)
    },
    state,
    run(id) {
      const found = state(id)
      if (found.ok) entries.get(id)?.handler.run()
      return found
    }
  }
}
