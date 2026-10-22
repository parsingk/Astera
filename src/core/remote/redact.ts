// What every remote-related log line passes through (remote runtime design §4.7): the Gateway's stderr on its way
// to gateway.log, and the Host's own remote lines. It removes the shapes a secret travels in, so a line that echoes
// a frame or an argument by mistake still writes nothing usable. It is a backstop, not a licence: code still never
// logs a token on purpose.

const RULES: Array<[RegExp, string]> = [
  // JSON fields: "token", "tokenHash", "code" (pairing codes), whatever their value.
  [/("(?:token|tokenHash|code)"\s*:\s*)"[^"]*"/g, '$1"[redacted]"'],
  // The same fields as Node's inspect prints them (an Error or an object on stderr): bare keys, values in '.
  [/(\b(?:token|tokenHash|code)\s*:\s*)'[^']*'/g, "$1'[redacted]'"],
  // Command-line arguments: --token x, --token=x, --code x, --code=x.
  [/(--(?:token|code)(?:=|\s+))\S+/g, '$1[redacted]'],
  // The pairing string carries the code.
  [/astera-pair:v1:\S+/g, 'astera-pair:[redacted]'],
  // A 43-character base64url run (a 32-byte token) after the word "token".
  [/(token\W{1,3})[A-Za-z0-9_-]{43}\b/gi, '$1[redacted]']
]

export function redactSecrets(line: string): string {
  let out = line
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

/** A secret shorter than this is too common a run of text to take out of a log line (docs/cli.md says so). */
export const REDACT_MIN = 4
/** A line of a secret of many lines shorter than this is too common to take out on its own. */
const REDACT_LINE_MIN = 8

/** What a log hides for a set of secret values, a plugin's (2c final review I4, M15) or the shared extensions' (Agent
 *  Control Plane release 1 design §4.9): each value; each line of a value of many lines, since a log is written a line
 *  at a time; and each value as JSON writes it, for a plugin that prints its settings. Longest first, so a secret that
 *  holds a shorter one is hidden whole. */
export function redactionTerms(values: Iterable<string>): string[] {
  const terms = new Set<string>()
  for (const v of values) {
    if (v.length < REDACT_MIN) continue
    terms.add(v)
    if (/[\r\n]/.test(v))
      for (const l of v.split(/\r\n|\r|\n/)) if (l.trim().length >= REDACT_LINE_MIN) terms.add(l.trim())
    const json = JSON.stringify(v).slice(1, -1)
    if (json !== v) terms.add(json)
  }
  return [...terms].sort((a, b) => b.length - a.length)
}

/** The line with every term (from `redactionTerms`, longest first) replaced by `[redacted]`. */
export function redactTerms(line: string, terms: readonly string[]): string {
  let out = line
  for (const t of terms) out = out.split(t).join('[redacted]')
  return out
}
