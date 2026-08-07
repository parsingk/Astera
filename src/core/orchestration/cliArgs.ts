// Argument parser for the astera CLI.
// The parser lives in core and the CLI (src/cli/) imports it — a single source of truth. A second
// copy would drift.

export interface ParsedArgs {
  cmd: string
  args: Record<string, unknown>
  /** Flags whose value was '-'. The caller reads stdin and fills them in */
  wantsStdin: string[]
  json: boolean
}

export const camel = (flag: string): string =>
  flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Flags to interpret as numbers */
const NUMERIC = new Set(['timeoutMs', 'limit'])
/** Flags to interpret as JSON arrays. ask's --options is CSV, so it is not here */
const JSON_ARRAY = new Set(['deps'])

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  if (argv.length === 0) return { error: 'a command is required (try: help)' }
  const cmd = argv[0]
  if (cmd.startsWith('-')) return { error: `expected a command, got flag: ${cmd}` }

  const args: Record<string, unknown> = {}
  const wantsStdin: string[] = []
  let json = false

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) return { error: `unexpected argument: ${tok}` }
    const key = camel(tok.slice(2))
    const next = argv[i + 1]
    const hasValue = next !== undefined && !next.startsWith('--')
    if (key === 'json') {
      json = true
      continue
    }
    if (!hasValue) {
      args[key] = true
      continue
    }
    i++
    if (next === '-') {
      wantsStdin.push(key)
      continue
    }
    if (NUMERIC.has(key)) {
      // ECMAScript ToNumber turns an empty or whitespace string into 0, so check for that explicitly
      if (next.trim() === '' || !Number.isFinite(Number(next)))
        return { error: `--${tok.slice(2)} must be a number` }
      args[key] = Number(next)
      continue
    }
    // gate-create's --options is a JSON array, ask's --options is CSV — the bracket tells them apart
    if (JSON_ARRAY.has(key) || (key === 'options' && next.trimStart().startsWith('['))) {
      try {
        const parsed: unknown = JSON.parse(next)
        if (!Array.isArray(parsed)) throw new Error('not an array')
        args[key] = parsed
      } catch {
        return { error: `--${tok.slice(2)} must be a JSON array` }
      }
      continue
    }
    args[key] = next
  }
  return { cmd, args, wantsStdin, json }
}
