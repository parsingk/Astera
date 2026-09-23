import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BROWSER_VERBS, NOUNS, camel, parseArgs, verbsOf } from './cliArgs'
import { USAGE, spelledCommand, usageFor, type PublicCommand } from './cliUsage'
import { agentContext } from './cliAgentContext'

/** 사람이 치는 모양(`jobs wait`)이 아니라 표의 키(`jobs-wait`). */
const commandsFromNouns = (): string[] =>
  Object.entries(NOUNS).flatMap(([noun, verbs]) => verbs.map((verb) => `${noun}-${verb}`))

describe('cliUsage — 표는 공개 표면과 정확히 같다', () => {
  // 컴파일러가 이미 같은 것을 잡는다(USAGE 는 NOUNS 에서 파생한 키 타입의 Record 다). 이 테스트는
  // 그 타입이 나중에 넓혀졌을 때를 위한 두 번째 증인이다 — 타입이 `Record<string, …>` 로 풀리면
  // 컴파일은 조용해지지만 이 단언은 깨진다.
  it('NOUNS 의 모든 noun/verb 와 단독 명령이 각각 하나씩, 그 밖은 없다', () => {
    const expected = [
      ...commandsFromNouns(),
      ...BROWSER_VERBS.map((v) => `browser-${v}`),
      'version',
      'status',
      'help',
      'agent-context'
    ].sort()
    expect(Object.keys(USAGE).sort()).toEqual(expected)
  })

  it('모든 항목에 한 줄 요약이 있다', () => {
    for (const [cmd, entry] of Object.entries(USAGE)) {
      expect(entry.summary, `${cmd} 의 요약이 비어 있다`).not.toBe('')
      expect(entry.summary, `${cmd} 의 요약이 여러 줄이다`).not.toContain('\n')
    }
  })
})

describe('cliUsage — 세 층', () => {
  it('--help 이 없으면 아무것도 아니다', () => {
    expect(usageFor(['jobs', 'list'])).toBeNull()
    expect(usageFor(['help'])).toBeNull()
    expect(usageFor([])).toBeNull()
  })

  it('astera --help / -h 는 모든 공개 명령을 한 줄씩 낸다', () => {
    for (const argv of [['--help'], ['-h']]) {
      const r = usageFor(argv)
      expect(r).not.toBeNull()
      const text = (r as { text: string }).text
      // `agent-context` 는 대시가 있지만 한 낱말이다 — 쪼개어 찍으면 없는 명령을 가르치게 된다.
      for (const cmd of Object.keys(USAGE))
        expect(text).toContain(cmd === 'agent-context' ? cmd : cmd.replace(/-(?=[^-]*$)/, ' '))
    }
  })

  // 명사와 동사를 가르는 대시와, 이름 안의 대시를 가른다. 쪼개어 찍으면 `astera agent context`
  // 라는 없는 명령이 사용법에 실리고, 그 줄은 파서에서 `agent` 로 떨어진다.
  // phase D. 명사 자체에 대시가 있다 — `run-configs list` 는 `run configs-list` 가 아니다.
  it('대시가 든 명사의 동사는 마지막 대시에서 가른다', () => {
    expect(spelledCommand('run-configs-list')).toBe('run-configs list')
    expect(spelledCommand('run-configs')).toBe('run-configs')
    expect(spelledCommand('run-worktree-set')).toBe('run-worktree-set')
    const text = (usageFor(['run-configs', 'list', '--help']) as { text: string }).text
    expect(text).toContain('astera run-configs list --job <jobId>')
  })

  it('한 낱말짜리 명령은 대시를 쪼개지 않는다', () => {
    const text = (usageFor(['agent-context', '--help']) as { text: string }).text
    expect(text).toContain('astera agent-context')
    expect(text).not.toContain('astera agent context')
  })

  it('astera <noun> --help 는 그 noun 의 동사만 낸다', () => {
    const text = (usageFor(['jobs', '--help']) as { text: string }).text
    for (const verb of NOUNS.jobs) expect(text).toContain(verb)
    // 다른 noun 의 것이 섞이지 않는다 — 이 층이 있는 이유가 좁히는 것이다
    expect(text).not.toContain('resume')
  })

  it('astera <noun> <verb> --help 는 그 명령의 플래그를 낸다', () => {
    const text = (usageFor(['jobs', 'wait', '--help']) as { text: string }).text
    expect(text).toContain('astera jobs wait --id <jobId> [--timeout-ms <ms>]')
    expect(text).toContain('required')
  })

  it('명령 뒤에 플래그가 더 있어도 --help 가 이긴다 — 명령을 돌리지 않는다', () => {
    expect(usageFor(['jobs', 'list', '--quiet', '--help'])).toEqual({
      text: expect.stringContaining('astera jobs list')
    })
  })

  it('browser 의 두 하위 명령도 같은 세 층이다', () => {
    const noun = (usageFor(['browser', '--help']) as { text: string }).text
    expect(noun).toContain('js')
    expect(noun).toContain('help')
    const js = (usageFor(['browser', 'js', '--help']) as { text: string }).text
    expect(js).toContain('astera browser js')
    expect(js).toContain('--file <path>')
  })

  it('단독 명령도 제 사용법이 있다', () => {
    expect((usageFor(['version', '--help']) as { text: string }).text).toContain('astera version')
    expect((usageFor(['status', '--help']) as { text: string }).text).toContain('astera status')
    // `astera help` 자신은 그대로 가이드를 찍는다(run.ts). 여기서 답하는 것은 `--help` 를 붙인 쪽뿐이다
    expect((usageFor(['help', '--help']) as { text: string }).text).toContain('astera help')
  })

  it('모르는 동사와 공개 표면 밖의 명령은 사용법이 아니라 안내다', () => {
    expect(usageFor(['jobs', 'bogus', '--help'])).toEqual({
      error: expect.stringContaining('unknown jobs subcommand: bogus')
    })
    expect(usageFor(['worker-start', '--help'])).toEqual({
      error: expect.stringContaining('no usage for worker-start')
    })
  })

  // 옛 이름을 들고 오는 것은 사람이 아니라 매번 `astera help` 를 읽고 시작하는 에이전트이고
  // (cliArgs 의 RENAMED), 그쪽이야말로 자기가 기억하는 이름에 --help 를 붙일 쪽이다.
  // parseArgs 앞에서 답하는 바람에 그 힌트를 주는 자리를 한 번 잃었다.
  it('개명된 옛 이름에는 사용법이 없다고 하지 않고 새 이름을 알려 준다', () => {
    expect(usageFor(['run-list', '--help'])).toEqual({
      error: 'run-list was renamed to `jobs list` (try: astera jobs list --help)'
    })
  })

  // Object.prototype 의 이름들. 막지 않으면 verbsOf 가 함수를 돌려주고 verbs.map 에서 죽는다 —
  // 종료 코드 2 가 아니라 처리되지 않은 예외가 된다.
  it('constructor·toString 같은 이름도 조용히 2로 끝난다', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(usageFor([name, '--help']), name).toEqual({
        error: expect.stringContaining(`no usage for ${name}`)
      })
    }
  })
})

// 텍스트 가드 — docs/cli.md 의 `## Command reference` 블록. ipcConvergenceWiring.test.ts 와 같은
// 부류다: 두 글이 같은 것을 말하는지는 이 저장소의 어떤 유닛 테스트도 확인하지 못하고, 사람이 읽고
// 행동하는 것은 문서 쪽이다.
//
// **비교하는 것은 명령의 집합과 각 명령의 플래그다** — 이름, 값을 받는가, 필수인가. 문구와
// 자리표시자 이름(`<jobId>` 대 `<jobId | runId>`)은 비교하지 않는다. 둘은 읽는 사람이 다르고,
// 그것까지 묶으면 옳은 문서를 고쳤다는 이유로 테스트가 깨진다.
const docPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/cli.md'
)

interface DocFlag {
  name: string
  takesValue: boolean
  required: boolean
}

/** `## Command reference` 아래 **첫** 울타리 블록. 표지가 없으면 조용히 빈 것을 비교하는 대신
 *  여기서 던진다. */
function commandReferenceBlock(text: string): string {
  const heading = text.indexOf('\n## Command reference')
  if (heading < 0) throw new Error('docs/cli.md has no `## Command reference` heading')
  const open = text.indexOf('```text', heading)
  if (open < 0) throw new Error('no ```text block under `## Command reference` in docs/cli.md')
  const start = open + '```text\n'.length
  const close = text.indexOf('```', start)
  if (close < 0) throw new Error('the command reference block in docs/cli.md is never closed')
  return text.slice(start, close)
}

/** 한 줄의 플래그들. 대괄호 깊이가 필수와 선택을 가른다 — `[--job <jobId>]` 는 선택이다. */
function flagsIn(spec: string): DocFlag[] {
  const out: DocFlag[] = []
  let depth = 0
  const re = /\[|\]|--([a-z][a-z-]*)(\s+<[^>]*>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(spec)) !== null) {
    if (m[0] === '[') depth++
    else if (m[0] === ']') depth--
    else out.push({ name: m[1], takesValue: typeof m[2] === 'string', required: depth === 0 })
  }
  return out
}

/**
 * 한 줄에서 명령들과 그 플래그를.
 *
 * **동사 자리에서만 `|` 를 가른다.** `astera host status | start | stop` 은 세 명령이고,
 * `--id <jobId | runId>` 의 `|` 는 자리표시자 안이라 명령이 아니다. 그래서 noun 뒤에서
 * `동사 (| 동사)*` 만 읽고 거기서 멈춘다 — 그 뒤는 전부 플래그이거나 설명이다.
 */
function commandsInLine(line: string): { commands: string[]; flags: DocFlag[] } {
  const tok = line.trim().split(/\s+/)
  if (tok[0] !== 'astera') throw new Error(`not a command line: ${line}`)
  const noun = tok[1]
  const verbs: readonly string[] | undefined =
    noun === 'browser' ? BROWSER_VERBS : (NOUNS as Record<string, readonly string[] | undefined>)[noun]
  if (verbs === undefined)
    return { commands: [noun], flags: flagsIn(tok.slice(2).join(' ')) }
  let i = 2
  const picked: string[] = []
  for (;;) {
    const verb = tok[i]
    if (verb === undefined || !verbs.includes(verb))
      throw new Error(`docs/cli.md: \`${line.trim()}\` — ${String(verb)} is not a verb of ${noun}`)
    picked.push(verb)
    i++
    if (tok[i] !== '|') break
    i++
  }
  return { commands: picked.map((v) => `${noun}-${v}`), flags: flagsIn(tok.slice(i).join(' ')) }
}

const byName = (a: DocFlag, b: DocFlag): number => a.name.localeCompare(b.name)

const flagsOf = (cmd: PublicCommand): DocFlag[] =>
  (USAGE[cmd].flags ?? [])
    .map((f) => ({ name: f.name, takesValue: f.value !== undefined, required: f.required === true }))
    .sort(byName)

// **전역 플래그는 표에 없다** — `USAGE` 는 명령마다의 플래그이고 `--json`·`--quiet` 같은 것은 어느
// 명령의 것도 아니다. 그래서 위의 명령 가드가 이것들을 보지 못하고, 그 사이로 `--no-keepalive` 가
// 스키마에만 있고 사용법에도 문서에도 없는 상태로 살 수 있었다. 여기서 그 자리 둘을 마저 못 박는다.
//
// **무엇을 못 박지 않는지도 적어 둔다:** 문구다. 문서가 이 플래그를 *어떻게* 설명하는지, 기다림의
// 줄이 어떤 모양인지는 아무것도 지키지 않는다 — 두 글은 읽는 사람이 다르고, 문구까지 묶으면 옳은
// 문서를 고쳤다는 이유로 테스트가 깨진다(이 파일의 명령 가드가 자리표시자를 비교하지 않는 것과
// 같은 판단이다).
describe('cliUsage — 전역 플래그는 사용법과 문서에도 있다', () => {
  const globals = agentContext().globalFlags.map((f) => f.name)
  const doc = readFileSync(docPath, 'utf8')

  it('스키마가 적은 전역 플래그는 문서에 이름이 있다', () => {
    for (const name of globals) expect(doc, name).toContain(`--${name}`)
  })

  // 루트 사용법은 `--json` 을 이름으로 부르지 않는다("output is JSON") — 그래서 전부를 돌지 않고,
  // 출력 모양을 고르는 플래그들만 본다.
  it('출력을 고르는 플래그는 루트 사용법에도 있다', () => {
    const root = (usageFor(['--help']) as { text: string }).text
    for (const name of ['human', 'quiet', 'no-keepalive']) {
      expect(globals, name).toContain(name)
      expect(root, name).toContain(`--${name}`)
    }
  })
})

describe('cliUsage — docs/cli.md 의 명령 목록과 같다', () => {
  const lines = commandReferenceBlock(readFileSync(docPath, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('astera '))
  const parsed = lines.map(commandsInLine)

  it('문서가 적은 명령과 표의 명령이 같다', () => {
    const documented = parsed.flatMap((p) => p.commands).sort()
    expect(documented).toEqual(Object.keys(USAGE).sort())
  })

  it('명령마다 플래그가 같다 — 이름, 값을 받는가, 필수인가', () => {
    for (const { commands, flags } of parsed) {
      for (const cmd of commands) {
        expect(USAGE[cmd as PublicCommand], `${cmd} is in docs/cli.md but not in USAGE`).toBeDefined()
        expect([...flags].sort(byName), `flags of \`${cmd.replace('-', ' ')}\``).toEqual(
          flagsOf(cmd as PublicCommand)
        )
      }
    }
  })
})

// 텍스트 가드 — `astera help` 가 내는 가이드(resources/skills/orchestration-guide.md). 위의 가드가
// docs/cli.md 에 하는 일을 에이전트가 읽는 쪽에 한다. 에이전트는 가이드의 줄을 그대로 친다.
//
// **둘을 본다.** 하나, 에이전트에게 알려야 하는 공개 명령이 가이드의 명령 줄에 있다 — 가이드가
// 그것들을 한 번도 적지 않은 채로 phase C·D 가 나갔고, 에이전트는 모르는 명령을 쓰지 않는다. 둘,
// 가이드의 울타리 블록에서 `astera <공개 명사>` 로 시작하는 줄은 실제로 가르는 명령이고, 그 명령이
// 받는 플래그만 쓴다. 세션 전용 명령(`task-create` 등)의 플래그는 어디에도 선언되어 있지 않아
// 여기서도 보지 않는다(cliAgentContext.ts 의 "standing risk").
//
// 줄 하나만 읽는다: `\` 로 이어지는 다음 줄의 플래그는 보지 않고, `<<` 와 `#` 부터는 셸의 것이다.
const guidePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../resources/skills/orchestration-guide.md'
)

/** 따옴표를 벗기는 정도의 셸 낱말 가르기. 가이드의 줄은 확장할 것이 없는 줄이다. */
function shellWords(line: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 울타리 블록 안에서 `astera ` 로 시작하는 줄, 셸이 읽는 꼬리(`<<`, `#`, 이어짐 `\`)를 뗀 것. */
function guideCommandLines(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced || !line.startsWith('astera ')) continue
    out.push(line.replace(/\s(<<|#).*$/, '').replace(/\s\\$/, '').trim())
  }
  return out
}

describe('orchestration-guide — 에이전트에게 공개 명령을 가르친다', () => {
  const lines = guideCommandLines(readFileSync(guidePath, 'utf8'))
  const globals = new Set(agentContext().globalFlags.map((f) => camel(f.name)))
  /** 가이드의 줄 중 공개 명사로 시작하는 것을 파싱한 결과. 동사 없는 옛 세션 명령(`accounts --json`)은
   *  USAGE 에 없으므로 `usage` 가 비어 있다. */
  const publicLines = lines
    .map((line) => ({ line, words: shellWords(line).slice(1) }))
    .filter(({ words }) => words[0] === 'browser' || verbsOf(words[0]) !== undefined)
    .map(({ line, words }) => ({ line, parsed: parseArgs(words) }))

  it('에이전트가 쓸 공개 명령이 가이드의 명령 줄에 있다', () => {
    const shown = new Set(publicLines.flatMap(({ parsed }) => ('cmd' in parsed ? [parsed.cmd] : [])))
    for (const cmd of [
      'jobs-create',
      'tasks-add',
      'accounts-list',
      'run-configs-list',
      'sessions-list',
      'sessions-read',
      'sessions-send',
      'skills-list',
      'skills-install',
      'requests-show'
    ])
      expect(shown.has(cmd), `\`astera ${cmd.replace(/-(?=[a-z]+$)/, ' ')}\` is on no command line of the guide`).toBe(true)
  })

  it('공개 명사로 시작하는 줄은 가르는 명령이고, 그 명령의 플래그만 쓴다', () => {
    expect(publicLines.length).toBeGreaterThan(0)
    for (const { line, parsed } of publicLines) {
      if ('error' in parsed) throw new Error(`guide: \`${line}\` — ${parsed.error}`)
      const usage = USAGE[parsed.cmd as PublicCommand] as (typeof USAGE)[PublicCommand] | undefined
      if (usage === undefined) continue // 동사 없는 세션 명령 — 공개 표의 것이 아니다
      const known = new Set((usage.flags ?? []).map((f) => camel(f.name)))
      for (const key of [...Object.keys(parsed.args), ...parsed.wantsStdin])
        expect(known.has(key) || globals.has(key), `guide: \`${line}\` — --${key} is not a flag of ${parsed.cmd}`).toBe(
          true
        )
    }
  })
})
