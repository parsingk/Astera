// What can keep a shared MCP server out of the registry, and the import dialog's default for "keep as a secret" (Agent
// Control Plane release 1 design D11, release 2 Gateway design §4.6). Release 1 also refused environment names that
// the CLIs or the session's tools read, since a value then landed in the session's environment; with the Gateway a
// server's values reach only its own process, so those rules went.

export type NotShareableReason = 'env-reference' | 'astera-own' | 'header-secret' | 'arg-secret'

/** A name that reads as a credential, the key list `sanitize` uses; the import dialog's default for "keep as secret". */
export function looksSecret(name: string): boolean {
  return /api[-_]?key|access[-_]?key|secret|token|password|credential/i.test(name)
}
