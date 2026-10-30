// Settings › Security & Access › Findings' and the Agent profiles mark's way to the Host (lifecycle design §7): the Host's
// own `agent-profiles-audit*` commands, sent over the app's `orch-call` as the app, one method a command, so the renderer
// names no other command. The Host computes the findings, keeps the ignores and checks every argument (a note of one
// line, a key a current finding has); this only says what it answered.
import type { FindingsApi } from '../../core/types'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

export function createFindingsRoute(d: { call: Call }): FindingsApi {
  const send = hostSender(d)
  return {
    list: (all) => send('agent-profiles-audit', { all: all === true }),
    ignore: (key, note) => send('agent-profiles-audit-ignore', note === undefined ? { key } : { key, note }),
    unignore: (key) => send('agent-profiles-audit-unignore', { key })
  }
}
