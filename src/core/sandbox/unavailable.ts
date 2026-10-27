// The error a session start throws when the CLI's own sandbox cannot be used. Callers match the prefix, so a session never
// starts quietly without the protection the profile asked for.
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

export function sandboxUnavailable(code: string): Error {
  return new Error(`${SANDBOX_UNAVAILABLE}: ${code}`)
}
