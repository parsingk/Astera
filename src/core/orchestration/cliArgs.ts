// Argument parser for the astera CLI.
// The parser lives in core and the CLI (src/cli/) imports it — a single source of truth. A second
// copy would drift.

export interface ParsedArgs {
  cmd: string
  args: Record<string, unknown>
  /** Flags whose value was '-'. The caller reads stdin and fills them in */
  wantsStdin: string[]
  json: boolean
  /** `--human` — 칸을 맞춘 표(공개 CLI 설계 §6). 기본이 아니라 켜는 것인 이유는
   *  run.ts 의 outputMode 에 있다 — 이 CLI 는 TTY 를 볼 수 없다. */
  human: boolean
  /** `--quiet` — ids only, one per line. */
  quiet: boolean
}

export const camel = (flag: string): string =>
  flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Flags to interpret as numbers */
const NUMERIC = new Set(['timeoutMs', 'limit'])
/** Flags to interpret as JSON arrays. ask's --options is CSV, so it is not here */
const JSON_ARRAY = new Set(['deps'])
/** Flags that may appear more than once and always arrive as an array. Everything else keeps the
 *  last value, which is what every existing caller expects. */
const REPEATABLE = new Set(['check'])

const BROWSER_SUBCOMMANDS = new Set(['js', 'help'])

/**
 * 두 낱말로 치는 명령들 — `astera jobs list`. **공개 표면은 전부 이 모양이다**(공개 CLI 설계 §5).
 *
 * 서버가 보는 것은 여전히 한 토큰(`jobs-list`)이다. 사람이 읽는 모양과 전선 위의 이름을 가른
 * 것은 `browser js` 가 이미 하던 일이고, 그 관례를 넓혔을 뿐이다.
 *
 * 코디네이터 전용 명령(worker-start, send, check, ask, gate-create, task-create…)은 여기 없다. 앱
 * 밖에서 치는 사람이 없으므로 개명이 가이드 재작성만 사고 아무것도 주지 않는다.
 *
 * **표면은 자란다.** 여기 적힌 것은 지금 앱이 답할 수 있는 것뿐이다 — `runs cancel` 은
 * 모델에 "취소된 회차" 가 없어서 그것을 먼저 정해야 하고, 그 뒤의 쓰기 동사들도 각자 구현되는
 * 단계에서 들어온다. 없는 동사를 미리 적어 두면 사람이 친 것이 "모르는 명령"(501)으로
 * 떨어진다 — 아직 안 만들어졌을 뿐인데 앱과 CLI 의 버전이 갈렸다고 말하는 셈이다.
 */
const NOUNS: Record<string, readonly string[]> = {
  projects: ['list', 'get', 'find'],
  jobs: ['list', 'get', 'wait', 'run'],
  runs: ['list', 'get', 'wait'],
  tasks: ['list'],
  questions: ['list', 'get', 'answer']
}

/**
 * 없어진 이름과 그것을 대신하는 이름.
 *
 * **아직 없는 이름을 가리키지 않는다.** 여기 적을 수 있는 것은 새 이름이 실제로 도는 것뿐이다 —
 * "jobs run 으로 바뀌었다" 고 말해 놓고 그것이 모르는 명령이면 안내가 아니라 거짓말이다.
 *
 * **별칭이 아니다 — 명령은 돌지 않는다.** 대신 무엇을 치면 되는지 말한다. 옛 이름을 쓰던 것은
 * 사람이 아니라 매번 `astera help` 를 읽고 시작하는 에이전트이고(handover.ts), 그쪽은 이 한 줄로
 * 스스로 고친다. 별칭을 두면 가이드를 끝까지 읽는 에이전트의 머릿속에 어휘가 둘 남는다.
 */
export const RENAMED: Record<string, string> = {
  'run-list': 'jobs list',
  'run-show': 'jobs get',
  'task-list': 'tasks list',
  'gate-list': 'questions list'
}

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  if (argv.length === 0) return { error: 'a command is required (try: help)' }
  let cmd = argv[0]
  if (cmd.startsWith('-')) return { error: `expected a command, got flag: ${cmd}` }
  // The browser is the one two-word command: `astera browser js`, `astera browser help`. Joined here
  // into `browser-js` / `browser-help` so the server and the tests see one token, like every other
  // command. The rest of the line parses as flags from the third word on.
  let first = 1
  const renamed = RENAMED[cmd]
  if (renamed !== undefined) return { error: `${cmd} was renamed to \`${renamed}\` (astera help)` }
  if (cmd === 'browser') {
    const sub = argv[1]
    if (sub === undefined || sub.startsWith('-')) return { error: 'browser needs a subcommand: js or help' }
    if (!BROWSER_SUBCOMMANDS.has(sub)) return { error: `unknown browser subcommand: ${sub} (expected js or help)` }
    cmd = `browser-${sub}`
    first = 2
  } else if (NOUNS[cmd] !== undefined) {
    const verbs = NOUNS[cmd]
    const sub = argv[1]
    if (sub === undefined || sub.startsWith('-'))
      return { error: `${cmd} needs one of: ${verbs.join(', ')}` }
    if (!verbs.includes(sub))
      return { error: `unknown ${cmd} subcommand: ${sub} (expected ${verbs.join(', ')})` }
    cmd = `${cmd}-${sub}`
    first = 2
  }

  const args: Record<string, unknown> = {}
  const wantsStdin: string[] = []
  let json = false
  let human = false
  let quiet = false

  for (let i = first; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) return { error: `unexpected argument: ${tok}` }
    const key = camel(tok.slice(2))
    const next = argv[i + 1]
    const hasValue = next !== undefined && !next.startsWith('--')
    if (key === 'json') {
      json = true
      continue
    }
    if (key === 'human') {
      human = true
      continue
    }
    if (key === 'quiet') {
      quiet = true
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
    if (REPEATABLE.has(key)) {
      const prev = args[key]
      args[key] = Array.isArray(prev) ? [...prev, next] : [next]
      continue
    }
    args[key] = next
  }
  if (cmd === 'browser-js') {
    const hasFile = args.file !== undefined || wantsStdin.includes('file')
    const hasScript = args.script !== undefined || wantsStdin.includes('script')
    if (hasFile && hasScript) return { error: 'browser js takes one script: --file or --script, not both' }
    // `astera browser js <<'EOF' … EOF` — the script is the whole of stdin, with no flag to say so.
    // Only when neither --script nor --file was given; `--script -` already asked.
    if (!hasScript && !hasFile) wantsStdin.push('script')
  }
  return { cmd, args, wantsStdin, json, human, quiet }
}
