// Settings › Agent profiles' way to the Host (Agent Profiles design §8): the Host's own `agent-profiles-*` commands, sent
// over the app's `orch-call` as the app, one method a command the tab and the pickers use, so the renderer names no
// other command. The Host owns the store and checks everything; this only says what it answered.
import type { AgentProfilesApi } from '../../core/types'
import { READINESS_RUN_MS, SETUP_RUN_MS } from '../../core/sandbox/windowsReadiness'
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

/** How long the app waits for 설정하기: Codex's setup waits on the person at Windows' administrator prompt (SETUP_RUN_MS),
 *  with the headroom the Host's answer needs to come back. */
export const SANDBOX_SETUP_DEADLINE_MS = SETUP_RUN_MS + TIMEOUT_HEADROOM_MS

/** How long the app waits for the readiness of a profile's Codex accounts: the Host asks them at once, each with Codex's
 *  doctor and, on a home doctor calls complete, the echo, each run stopped at READINESS_RUN_MS. */
export const SANDBOX_READINESS_DEADLINE_MS = 2 * READINESS_RUN_MS + TIMEOUT_HEADROOM_MS

/** Nothing here copies files the way an extensions change does, so every call but the sandbox's setup and readiness
 *  waits the usual time. `afterSetup` runs once a setup has answered, whatever it said: this process asks the same readiness question
 *  for its own spawns, and must not keep an answer the setup made old. */
export function createAgentProfilesRoute(d: { call: Call; afterSetup?: () => void }): AgentProfilesApi {
  const send = hostSender(d)
  return {
    list: () => send('agent-profiles-list', {}),
    create: (fields) => send('agent-profiles-create', { ...fields }),
    update: (id, changes) => send('agent-profiles-update', { id, ...changes }),
    archive: (id) => send('agent-profiles-archive', { id }),
    restore: (id) => send('agent-profiles-restore', { id }),
    remove: (id) => send('agent-profiles-delete', { id }),
    sandboxSetup: async (profileId, accountId) => {
      const r = await send('agent-profiles-sandbox-setup', { id: profileId, accountId }, { timeoutMs: SANDBOX_SETUP_DEADLINE_MS })
      d.afterSetup?.()
      return r
    },
    sandboxReadiness: (profileId) => send('agent-profiles-sandbox-readiness', { id: profileId }, { timeoutMs: SANDBOX_READINESS_DEADLINE_MS }),
    // Task P: one file of the account's, read and written at once, so the usual wait
    sandboxDefaultRemove: (profileId, accountId) => send('agent-profiles-sandbox-default-remove', { id: profileId, accountId })
  }
}
