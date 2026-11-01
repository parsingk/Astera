// The link failures a person can act on, each with its catalog sentence (ruling R17-1): the other side answered, so none
// of them is "does not answer", and a retry does not mend them. Settings › Remote Runtimes says them, and `astera runtimes
// ping` ends with them (final review F9). No node imports: the renderer reads this module.
import type { MessageKey } from '../i18n'

export const LINK_FAILURE_KEYS: Readonly<Record<string, MessageKey>> = {
  RUNTIME_AUTH_FAILED: 'settings.remote.link.authFailed',
  RUNTIME_IDENTITY_CHANGED: 'settings.remote.link.identityChanged',
  RUNTIME_PROTOCOL_MISMATCH: 'settings.remote.link.protocolMismatch'
}
