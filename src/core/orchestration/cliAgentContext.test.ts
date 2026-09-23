import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CLI_ERROR_CODES, exitCodeFor, nextStepsFor } from './cliOutput'
import { USAGE } from './cliUsage'
import { agentContext } from './cliAgentContext'

const ctx = agentContext()
const names = ctx.commands.map((c) => c.name)

describe('agent-context — 무엇이 실리는가', () => {
  it('공개 명령과 세션 전용 명령이 함께 실리고, 칸 하나가 그것을 가른다', () => {
    const publicNames = ctx.commands.filter((c) => c.public).map((c) => c.name).sort()
    expect(publicNames).toEqual(Object.keys(USAGE).sort())
    // 이 파일이 있는 이유가 이쪽이다 — 공개 표면 밖의 명령은 가이드의 산문에만 있었다
    for (const cmd of ['send', 'ask', 'check', 'worker-start', 'task-create', 'handoff'])
      expect(names, cmd).toContain(cmd)
  })

  it('명령마다 한 줄 요약과 칠 수 있는 첫 줄이 있다', () => {
    for (const c of ctx.commands) {
      expect(c.summary, `${c.name} 의 요약이 비어 있다`).not.toBe('')
      expect(c.summary, `${c.name} 의 요약이 여러 줄이다`).not.toContain('\n')
      expect(c.usage, `${c.name} 의 사용 줄`).toContain('astera ')
    }
  })

  // 두 낱말로 치는 것과 한 토큰으로 치는 것이 갈린다 — 에이전트가 이것을 틀리면 파서가 501 이
  // 아니라 "unknown jobs subcommand" 로 답한다
  it('공개 명령은 두 낱말, 세션 전용 명령은 한 토큰으로 적힌다', () => {
    const usageOf = (name: string): string => ctx.commands.find((c) => c.name === name)!.usage
    expect(usageOf('jobs-get')).toBe('astera jobs get --id <jobId|runId>')
    expect(usageOf('worker-start')).toContain('astera worker-start ')
    expect(usageOf('agent-context')).toBe('astera agent-context')
  })

  it('플래그는 이름·값을 받는가·필수인가·설명이다', () => {
    const start = ctx.commands.find((c) => c.name === 'worker-start')!
    expect(start.flags.find((f) => f.name === 'task')).toEqual({
      name: 'task',
      takesValue: true,
      required: true,
      about: expect.any(String)
    })
    expect(start.flags.find((f) => f.name === 'name')?.required).toBe(false)
    const create = ctx.commands.find((c) => c.name === 'run-create')!
    // 값이 없는 플래그 — 뒤의 토큰이 이 플래그의 것인지 아닌지가 부르는 쪽이 정해야 하는 것이다
    expect(create.flags.find((f) => f.name === 'convergence')?.takesValue).toBe(false)
  })

  it('종료 코드 표가 통째로 실리고, 숫자는 한 표에서 온다', () => {
    expect(ctx.exitCodes.map((e) => e.code)).toEqual([...CLI_ERROR_CODES])
    for (const e of ctx.exitCodes) {
      expect(e.exit, e.code).toBe(exitCodeFor(e.code))
      expect(e.meaning, e.code).not.toBe('')
    }
  })

  it('판 번호와 봉투의 모양이 실린다', () => {
    expect(ctx.protocol).toBe(1)
    expect(ctx.output.error).toContain('nextSteps')
    expect(ctx.globalFlags.map((f) => f.name)).toEqual([
      'json',
      'human',
      'quiet',
      'no-keepalive',
      'request-id',
      'help'
    ])
  })

  // **한 자리에 한 번 적힌다**(요청 영수증 설계 §3·§8). 명령마다 적는 쪽을 골랐다면 58 개를
  // 손으로 들고 있어야 하고, 빠뜨린 명령은 키를 받아 조용히 버린다 — 부르는 쪽이 그 플래그를 단
  // 이유가 다음에 무슨 일이 일어나는가에 대한 믿음이므로, 그것이 이 기능이 감당할 수 없는 실패다.
  it('--request-id 는 전역 플래그로 한 번만 실리고 명령마다 실리지 않는다', () => {
    const global = ctx.globalFlags.filter((f) => f.name === 'request-id')
    expect(global.length).toBe(1)
    expect(global[0].takesValue).toBe(true)
    for (const c of ctx.commands)
      expect(c.flags.map((f) => f.name), `${c.name} 이 --request-id 를 따로 싣고 있다`).not.toContain(
        'request-id'
      )
  })

  // 같은 이름이 둘이면 읽는 쪽이 어느 것을 믿을지 모른다
  it('이름이 겹치지 않고, 이름 순이다', () => {
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

// 컴파일러가 이미 같은 것을 잡는다 — command.ts 의 switch 는 `SwitchedCommand` 를 두고 갈리고,
// 그 타입은 이 스키마에서 파생한다. 이 테스트는 **그 타입이 나중에 `string` 으로 풀렸을 때를 위한
// 두 번째 증인**이다: 그러면 컴파일은 조용해지지만 아래 단언은 그 자리에서 깨진다.
//
// 읽는 것은 `case` 표지뿐이다. 그 밖의 어떤 것도 이 파일에서 읽지 않는다 — 본문을 읽기 시작하면
// 이 테스트가 command.ts 의 서식에 묶인다.
const commandSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'command.ts'),
  'utf8'
)

/** `handleCommand` 의 switch 가 가진 `case` 표지 전부. */
function casesInHandleCommand(): string[] {
  const start = commandSource.indexOf('export async function handleCommand')
  if (start < 0) throw new Error('command.ts has no handleCommand')
  const labels = [...commandSource.slice(start).matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1])
  if (labels.length === 0) throw new Error('command.ts: no case labels found under handleCommand')
  return [...new Set(labels)].sort()
}

/** 이 CLI 가 스스로 답하거나, switch 앞에서 답하거나, 명령 층 위에서 Host 가 답하는 명령들
 *  (`requests-show`) — cliAgentContext.ts 의 `NOT_SWITCHED`
 *  와 같은 목록이고, 거기서 내보내지 않는 이유는 타입이 그것을 이미 쓰고 있어서다. 둘이 갈라지면
 *  아래 단언이 깨진다. */
const NOT_SWITCHED = [
  'help',
  'browser-help',
  'agent-context',
  'host-start',
  'host-status',
  'host-stop',
  'browser-js',
  'handoff',
  'requests-show',
  'skills-list',
  'skills-install'
]

describe('agent-context — 명령 집합은 handleCommand 가 실제로 가르는 것이다', () => {
  it('switch 의 case 와 스키마의 (CLI 가 직접 답하지 않는) 명령이 정확히 같다', () => {
    expect(casesInHandleCommand()).toEqual(names.filter((n) => !NOT_SWITCHED.includes(n)).sort())
  })

  it('CLI 가 직접 답하는 명령에는 case 가 없다', () => {
    const cases = new Set(casesInHandleCommand())
    for (const cmd of NOT_SWITCHED) {
      expect(names, `${cmd} 가 스키마에 없다`).toContain(cmd)
      expect(cases.has(cmd), `${cmd} 에 case 가 생겼다`).toBe(false)
    }
  })

  // **`NOT_SWITCHED` 의 `satisfies` 는 이름이 스키마에 있다는 것만 증명한다.** 열 번째 이름을
  // 더하면 컴파일도 통과하고 위의 두 단언도 통과한 채, 실제로 치면 501 이 된다 — `case` 도 없고
  // 답하는 가지도 없기 때문이다.
  //
  // **이 단언이 드는 것은 그 반쪽의 일부다.** 확인하는 것은 "그 이름이 답을 만드는 세 파일
  // 어딘가의 **코드에서 비교된다**" 이지, "그 비교가 그 명령에 답한다" 가 아니다 — 둘은 다르고,
  // 글자로는 가를 수 없다. `run.ts` 의 `argsForCall` 이 `a.cmd === 'browser-js'` 로 stdin 모양만
  // 정하는 자리가 그 예다. 주석은 지우고 보므로 주석에 이름을 적어 통과시킬 수는 없다.
  // **네 번째 파일은 Host 다.** `requests-show` 는 CLI 가 답하지도, switch 앞에서 답하지도 않는다 —
  // 영수증은 상태 파일이 아니라 Host 의 메모리에 있어서(설계 §4) `state-get`·`state-put` 옆에서
  // 답한다. 이 목록에서 빠뜨리면 그 이름은 "아무 데서도 비교되지 않는" 것이 되고, 그것은 이
  // 단언이 잡으려는 결함과 같은 모양의 거짓 경보다.
  it('CLI 나 Host 가 직접 답한다는 열하나는 네 파일의 코드에서 비교된다', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const stripped = ['../../cli/run.ts', '../../cli/host.ts', './command.ts', '../../host/orch.ts']
      .map((rel) => readFileSync(path.resolve(here, rel), 'utf8'))
      // 블록 주석을 먼저 걷고 줄 주석을 걷는다 — 줄 끝에 붙은 `// 'doctor'` 도 함께 사라진다.
      .map((src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
      .join('\n')
    for (const cmd of NOT_SWITCHED)
      expect(stripped.includes(`'${cmd}'`), `${cmd} is compared nowhere`).toBe(true)
  })
})

// `nextSteps` 는 실행 가능한 명령 줄이라고 약속한다(cliOutput.ts). 손으로 쓴 표가 없는 명령을
// 가리키면 그 약속이 거짓이 되고, 부르는 쪽은 그것을 치고 나서야 안다.
describe('nextSteps 가 가리키는 것은 실재하는 명령이다', () => {
  /** 스키마가 적은 대로 친 모양: `jobs list`, `worker-start`. */
  const spoken = new Set(ctx.commands.map((c) => c.usage.split(' ').slice(1).join(' ')))
  const globals = new Set(ctx.globalFlags.map((f) => `--${f.name}`))

  /** 한 줄에서 명령 이름만. `astera jobs list --quiet` → `jobs-list`. */
  const commandIn = (line: string): string | null => {
    const tok = line.split(' ')
    if (tok[0] !== 'astera' || globals.has(tok[1])) return null
    const two = tok.slice(1, 3).join(' ')
    const hit = ctx.commands.find((c) => {
      const typed = c.usage.split(' ').slice(1).join(' ')
      return typed === two || typed.startsWith(`${two} `) || typed === tok[1] || typed.startsWith(`${tok[1]} `)
    })
    return hit?.name ?? null
  }

  const everyStep = (): { cmd: string | undefined; line: string }[] => {
    const out: { cmd: string | undefined; line: string }[] = []
    for (const code of CLI_ERROR_CODES)
      for (const cmd of [undefined, ...names]) for (const line of nextStepsFor({ code, cmd })) out.push({ cmd, line })
    return out
  }

  it('열 코드가 내놓는 모든 줄이 astera 의 실재하는 명령이다', () => {
    const steps = everyStep()
    expect(steps.length).toBeGreaterThan(0)
    for (const { line } of steps) {
      expect(line.split(' ')[0], line).toBe('astera')
      // `astera --help` 는 명령이 아니라 전역 플래그다
      if (globals.has(line.split(' ')[1])) continue
      expect(commandIn(line), `${line} is not a command this CLI has`).not.toBeNull()
    }
  })

  // **"도는 명령인가" 다음에 오는 질문: "이 오류를 만난 쪽이 그 명령을 부를 수 있는가."**
  // `ask` 는 워커도 부르는데 `inbox` 는 코디네이터 전용이라, 워커가 그 줄을 따르면 403 으로 5 를
  // 받았다. 줄이 틀린 것이 아니라 그 자리에서 아예 돌지 않는 것이고, 증상만 다른 같은 결함이다.
  // 규칙은 "코디네이터 전용 명령을 권하지 마라" 가 아니다 — `reply` 는 자신이 코디네이터 전용
  // 이므로 `inbox` 를 권해도 된다. 권하는 쪽이 전용이면 받는 쪽도 전용이어야 한다.
  it('코디네이터 전용 명령은 코디네이터 전용 명령에만 권한다', () => {
    const set = commandSource.match(/const COORDINATOR_ONLY = new Set\(\[([^\]]*)\]/)
    if (!set) throw new Error('command.ts has no COORDINATOR_ONLY set')
    const only = new Set([...set[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))
    expect(only.size).toBeGreaterThan(0)
    for (const { cmd, line } of everyStep()) {
      const step = commandIn(line)
      if (step === null || !only.has(step)) continue
      expect(cmd !== undefined && only.has(cmd), `${cmd ?? '(none)'} → ${line}: the caller cannot run it`).toBe(
        true
      )
    }
  })
})
