// Credits running short (higgsfield accounts design §3). The proxy never switches accounts (D2): it
// stops a job the current account cannot pay for and tells the agent to ask the person.

export const COST_KEYS = ['credits', 'cost', 'total_credits', 'price']
export const BALANCE_KEYS = ['credits', 'available_credits', 'balance']

export function numberAt(json: string, keys: string[]): number | null {
  let root: unknown
  try { root = JSON.parse(json) } catch { return null }
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v !== 'object' || v === null) continue
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k]
      const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
      if (Number.isFinite(n)) return n
    }
    stack.push(...Object.values(v as object).reverse())
  }
  return null
}

/** Index of the first word that is not a leading global flag (`--json generate create ...`). */
export const subIndex = (args: string[]): number => {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i++
  return i
}

export const isGenerateJob = (args: string[]): boolean => {
  const i = subIndex(args)
  return args[i] === 'generate' && (args[i + 1] === 'create' || args[i + 1] === 'workflow')
}

const WAIT_FLAGS = new Set(['--wait-timeout', '--wait-interval'])
export function costArgsFor(args: string[]): string[] {
  const rest: string[] = []
  const base = subIndex(args)   // leading global flags are dropped from the cost call
  for (let i = base + 2; i < args.length; i++) {
    const t = args[i]
    if (t === '--wait' || t === '--json' || t.startsWith('--wait-timeout=') || t.startsWith('--wait-interval=')) continue
    if (WAIT_FLAGS.has(t)) { i++; continue }
    rest.push(t)
  }
  return ['generate', 'cost', ...(args[base + 1] === 'workflow' ? ['workflow'] : []), ...rest, '--json']
}

export const looksOutOfCredits = (text: string): boolean =>
  /insufficient (credits|balance)|not enough credits|out of credits|credit(s)? (limit|exhausted)/i.test(text)

type Who = { label: string; email?: string; credits: number | null }
const credits = (n: number | null) => (n === null ? 'credits unknown' : `${n} credits`)

export function shortCreditsMessage(a: { current: Who; need: number | null; others: Who[] }): string {
  const cur = `Higgsfield account "${a.current.label}"${a.current.email ? ` (${a.current.email})` : ''} has ${
    a.current.credits === null ? 'too few credits' : `${a.current.credits} credits`}`
  const need = a.need === null ? '' : `; this job needs ${a.need}`
  const others = a.others.length
    ? ` Other accounts: ${a.others.map((o) => `"${o.label}" (${o.email ? `${o.email}, ` : ''}${credits(o.credits)})`).join(', ')}.`
    : ' There is no other account in Astera.'
  return `${cur}${need}.${others} Ask the user which account to use (offer them as choices; never pick one yourself), then run \`astera higgsfield use --account <account>\` and run this command again.\n`
}
