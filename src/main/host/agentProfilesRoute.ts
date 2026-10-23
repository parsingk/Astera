// Settings › Agent profiles' way to the Host (Agent Profiles design §8): the Host's own `agent-profiles-*` commands, sent
// over the app's `orch-call` as the app, one method a command the tab and the pickers use, so the renderer names no
// other command. The Host owns the store and checks everything; this only says what it answered.
import type { AgentProfilesApi } from '../../core/types'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

/** Nothing here copies files the way an extensions change does, so every call waits the usual time. */
export function createAgentProfilesRoute(d: { call: Call }): AgentProfilesApi {
  const send = hostSender(d)
  return {
    list: () => send('agent-profiles-list', {}),
    create: (fields) => send('agent-profiles-create', { ...fields }),
    update: (id, changes) => send('agent-profiles-update', { id, ...changes }),
    archive: (id) => send('agent-profiles-archive', { id }),
    restore: (id) => send('agent-profiles-restore', { id }),
    remove: (id) => send('agent-profiles-delete', { id })
  }
}
