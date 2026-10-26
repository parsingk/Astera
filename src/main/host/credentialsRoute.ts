// Settings › Security & Access › Credentials' way to the Host (credentials design §7): the Host's own `credentials-*`
// commands, sent over the app's `orch-call` as the app, one method a command the screen uses, so the renderer names no
// other command. Only the app's role may change the list; the Host checks that and everything else, this only says what
// it answered.
import type { CredentialsApi } from '../../core/types'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

export function createCredentialsRoute(d: { call: Call }): CredentialsApi {
  const send = hostSender(d)
  return {
    list: () => send('credentials-list', {}),
    uses: (q) => send('credentials-uses', { ...q }),
    addHideOnly: (e) => send('credentials-add-hide-only', { ...e }),
    editHideOnly: (id, changes) => send('credentials-edit-hide-only', { id, ...changes }),
    deleteHideOnly: (id) => send('credentials-delete-hide-only', { id }),
    setHiding: (id, hide) => send('credentials-set-hiding', { id, hide }),
    reset: () => send('credentials-reset', {})
  }
}
