/**
 * The pure data layer for a provider (which CLI it is).
 *
 * This file **imports no module at all** — node:path and node:fs included. That is because the renderer
 * (tsconfig.web) and main both use it. Values and function references that depend on fs or path live in
 * descriptor.ts (Node only).
 */

export type Provider = 'claude' | 'codex'

export const PROVIDERS = ['claude', 'codex'] as const satisfies readonly Provider[]

/** No provider = 'claude' — backward compatibility for existing accounts.json.
 *  This function is the only place in the whole app where an unknown value falls through to claude. */
export const providerOf = (a: { provider?: Provider }): Provider => a.provider ?? 'claude'

/** The type guard used to validate accounts.json (registry.isValidAccount).
 *  Because PROVIDERS is `as const` its type is readonly ['claude','codex'], so passing an unknown straight
 *  into includes is rejected by typecheck — it is widened to string once before comparing. */
export const isProvider = (v: unknown): v is Provider =>
  typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v)

export interface ProviderMeta {
  id: Provider
  /** The badge title and the radio label */
  displayName: string
  /** Does it use the statusLine mechanism. The usage bar, the usage context and scheduler key learning all hang on this one fact */
  usesStatusLine: boolean
}
// There is no supportsSettingsSync flag any more: both providers import settings now, they just do it
// differently (claude merges per key, codex replaces config.toml). The how lives on ProviderDescriptor
// .syncSettings; nothing left for the renderer to branch on.

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    usesStatusLine: true
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    usesStatusLine: false
  }
}

export const metaOf = (a: { provider?: Provider }): ProviderMeta => PROVIDER_META[providerOf(a)]
