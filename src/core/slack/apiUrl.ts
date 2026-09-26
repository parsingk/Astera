// The Slack API URL seam for the end to end run (plan ruling P15). Honoured only on a loopback host, so
// a stray environment variable can never send a token anywhere but this machine.

// The literals only (final review M4): `localhost` resolves through the hosts file, so it is not a
// guaranteed loopback, and this seam is honoured in production builds too.
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]'])

/** `ASTERA_SLACK_API_URL` when it is http(s) on the literal 127.0.0.1 or [::1], with a trailing slash
 *  (the SDK appends method names to it); otherwise undefined, and the SDK keeps its default. */
export function slackApiUrlFrom(env: Record<string, string | undefined>): string | undefined {
  const raw = env.ASTERA_SLACK_API_URL
  if (!raw) return undefined
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  if (!LOOPBACK.has(u.hostname)) return undefined
  return u.href.endsWith('/') ? u.href : `${u.href}/`
}
