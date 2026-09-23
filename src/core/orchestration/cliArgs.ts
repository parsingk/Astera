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
  /** `--no-keepalive` — nothing on stderr while a waiting command waits (cliKeepalive.ts).
   *
   *  **It is its own flag rather than a reading of `--quiet`.** The two shape different channels:
   *  `--quiet` decides what stdout carries, and a script that asked for ids on stdout has said
   *  nothing about whether it wants to be told that a one-hour wait is still alive. Folding them
   *  together would also leave no way to ask for one without the other. */
  noKeepalive: boolean
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

/** `astera browser <sub>`. Exported because cliUsage.ts prints usage for both of them, and a second
 *  copy of the list would drift from this one. */
export const BROWSER_VERBS = ['js', 'help'] as const

const BROWSER_SUBCOMMANDS = new Set<string>(BROWSER_VERBS)

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
 *
 * **`as const`, and exported.** cliUsage.ts derives the key type of its usage table from this
 * object, so a verb added here stops that file compiling until its usage text exists — the same
 * trick cliPublic.ts plays on the public field allowlist.
 */
export const NOUNS = {
  host: ['start', 'status', 'stop'],
  projects: ['list', 'get', 'find'],
  // `jobs create` 와 `tasks add` 는 phase C 다 — 앞의 것은 run-create 를 `--auto` 로, 뒤의 것은
  // task-create 를 부른다(command.ts). 코디네이터가 쓰는 두 이름은 그대로 남는다.
  jobs: ['list', 'get', 'wait', 'run', 'create'],
  runs: ['list', 'get', 'wait', 'stop', 'resume'],
  tasks: ['list', 'add'],
  questions: ['list', 'get', 'answer'],
  // `jobs create --coordinator-account` 와 `tasks add --account` 에 넣을 id 가 여기서 나온다.
  // 동사 없는 `accounts` 는 가이드가 가르치는 세션 명령 그대로다(BARE_NOUNS).
  accounts: ['list'],
  // **CLI 프로세스 안에서 답한다 — Host 도 앱도 없이**(run.ts, `help` 와 같은 자리). 프로필의
  // accounts.json 과 app-settings.json 을 읽고 계정의 설정 폴더에 스킬 파일을 심는다(cli/skills.ts).
  skills: ['list', 'install'],
  // **요청 영수증**(request receipts design §8). 여기 있는 것은 공개 표면이어서가 아니라 —
  // 답하는 것은 명령 층이 아니라 Host 다(host/orch.ts) — 이 모양이 그것을 `USAGE` 와
  // `docs/cli.md` 에 함께 적히게 만들기 때문이다. `--request-id` 는 반대로 여기 없다: 그것은
  // 한 명령의 동사가 아니라 모든 명령이 받는 전역 플래그이고, 그 자리는 cliAgentContext 의
  // `globalFlags` 다(설계 §3 — 명령 목록을 손으로 들고 있으면 빠뜨린 명령이 조용히 무시한다).
  requests: ['show']
} as const

/** 명사이면서 동사 없이도 명령인 이름. `accounts` 는 공개 명사가 되기 전부터 세션 명령이었고
 *  가이드가 `astera accounts --json` 으로 가르친다 — 동사 자리가 비었거나 플래그면 그 한 낱말
 *  명령으로 지나간다. 모르는 동사는 여전히 거절한다. */
const BARE_NOUNS = new Set(['accounts'])

/** The same table, keyed by a word the person typed rather than by one of the literal keys above.
 *
 *  **`Object.hasOwn`, not a plain lookup.** The key is whatever the person typed, and a plain object
 *  answers `constructor`, `toString` and `valueOf` with something inherited from `Object.prototype`.
 *  Unguarded, `astera constructor` reached `verbs.join(...)` on a function and died with a TypeError
 *  instead of exiting 2. The same reason guards `RENAMED` below. */
export const verbsOf = (noun: string): readonly string[] | undefined =>
  Object.hasOwn(NOUNS, noun) ? (NOUNS as Record<string, readonly string[]>)[noun] : undefined

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

/** The new name for an old one, or `undefined`. **Both readers go through this**, because the fact
 *  has to be the same in both places even though the sentence built from it is not: `parseArgs`
 *  points at the guide, and the usage path points at that command's own `--help`.
 *
 *  Guarded the same way `verbsOf` is: `RENAMED['constructor']` is a function, and unguarded it told
 *  the person that `constructor` had been renamed to `function Object() { … }`. */
export const renamedTo = (cmd: string): string | undefined =>
  Object.hasOwn(RENAMED, cmd) ? RENAMED[cmd] : undefined

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  if (argv.length === 0) return { error: 'a command is required (try: help)' }
  let cmd = argv[0]
  if (cmd.startsWith('-')) return { error: `expected a command, got flag: ${cmd}` }
  // The browser is the one two-word command: `astera browser js`, `astera browser help`. Joined here
  // into `browser-js` / `browser-help` so the server and the tests see one token, like every other
  // command. The rest of the line parses as flags from the third word on.
  let first = 1
  const renamed = renamedTo(cmd)
  if (renamed !== undefined) return { error: `${cmd} was renamed to \`${renamed}\` (astera help)` }
  const verbs = verbsOf(cmd)
  if (cmd === 'browser') {
    const sub = argv[1]
    if (sub === undefined || sub.startsWith('-')) return { error: 'browser needs a subcommand: js or help' }
    if (!BROWSER_SUBCOMMANDS.has(sub)) return { error: `unknown browser subcommand: ${sub} (expected js or help)` }
    cmd = `browser-${sub}`
    first = 2
  } else if (verbs !== undefined && !(BARE_NOUNS.has(cmd) && (argv[1] === undefined || argv[1].startsWith('-')))) {
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
  let noKeepalive = false

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
    // Read here rather than left in `args` for the same reason the three above are: it is a mode of
    // this process, not an argument to any command, and everything in `args` goes on the wire.
    if (key === 'noKeepalive') {
      noKeepalive = true
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
  return { cmd, args, wantsStdin, json, human, quiet, noKeepalive }
}
