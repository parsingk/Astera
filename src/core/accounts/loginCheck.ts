// The one login rule (C8). AccountRegistry, the Host's spawner and the Host's checks all answer "is
// this account logged in" here, so the three cannot drift apart: the evidence differs per provider
// and platform (claude is .credentials.json or the macOS Keychain, codex is auth.json), and that
// branching is the provider descriptor's, never the caller's.
import type { Account, Provider } from '../types'
import { descriptorOf, type ProviderDescriptor } from '../providers/descriptor'

/** Whether this account is logged in, by its provider's own probe — the rule AccountRegistry, the
 *  Host's spawner and the Host's checks share (C8). */
export function isLoggedIn(account: Account, descriptors: Record<Provider, ProviderDescriptor>): Promise<boolean> {
  return descriptorOf(descriptors, account).isLoggedIn(account.configDir)
}
