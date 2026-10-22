// Settings › Extensions' way to the Host (Agent Control Plane release 1 design §4.10): the Host's own `extensions-*`
// commands, sent over the app's `orch-call` as the app, one method a command the tab uses, so the renderer names no
// other command. The Host checks everything and answers names only; this only says what it answered.
import type { ExtensionsApi } from '../../core/types'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

/** A change (the `true` below) syncs every account's copies before it answers, so it waits as long as a plugin change. */
export function createExtensionsRoute(d: { call: Call }): ExtensionsApi {
  const send = hostSender(d)
  return {
    list: () => send('extensions-list', {}),
    discover: (accountId) => send('extensions-discover', { accountId }),
    import: (accountId, picks) => send('extensions-import', { accountId, picks }, true),
    setEnabled: (id, enabled) => send(enabled ? 'extensions-enable' : 'extensions-disable', { id }, true),
    remove: (id) => send('extensions-remove', { id }, true),
    sync: () => send('extensions-sync', {}, true),
    replace: (accountId, id) => send('extensions-replace', { accountId, id }, true),
    setIsolation: (id, isolation) => send('extensions-isolation', { id, isolation }, true)
  }
}
