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
