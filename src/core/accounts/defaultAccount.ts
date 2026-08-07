import type { Account, Provider } from '../types'
import { providerOf } from '../providers/meta'

/**
 * The default account of a provider — the source ⤓ (settings import) copies from, and the account the UI
 * marks with a `default` badge.
 *
 * The rule is **the earliest registered account that is logged in**, decided per provider. It is derived
 * rather than stored: nothing needs migrating as accounts come and go, and deleting the current default
 * simply hands the role to the next one.
 *
 * Why per provider rather than one for the whole app: claude keeps settings.json plus MCP, codex keeps a
 * single config.toml. Neither can be copied into the other, so one app-wide default would leave the other
 * CLI with no source at all — which is exactly the hole a codex-only user used to fall into.
 *
 * Why not "the home directory account" (~/.claude, ~/.codex), which is what this used to key on: the home
 * dir may not be registered here, or may not be logged in, and someone who only ever used this app has no
 * home account to speak of. Registration order covers all of those cases with one rule.
 */
export function defaultAccountIdOf(
  provider: Provider,
  accounts: readonly Account[],
  loggedInIds: ReadonlySet<string>
): string | null {
  let best: Account | null = null
  for (const account of accounts) {
    if (providerOf(account) !== provider || !loggedInIds.has(account.id)) continue
    // createdAt is ISO 8601 UTC, so a plain string compare is chronological.
    // Strictly-earlier-wins keeps whichever came first in accounts.json when timestamps are equal, and
    // that is registration order. Auto-detect registers several accounts inside a single loop and they
    // can land on the same millisecond, so without this tie-break the winner would come down to sort
    // stability.
    if (best === null || account.createdAt < best.createdAt) best = account
  }
  return best?.id ?? null
}
