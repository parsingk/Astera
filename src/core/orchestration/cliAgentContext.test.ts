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
    expect(ctx.globalFlags.map((f) => f.name)).toEqual(['json', 'human', 'quiet', 'help'])
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

/** 이 CLI 가 스스로 답하거나 switch 앞에서 답하는 명령들 — cliAgentContext.ts 의 `NOT_SWITCHED`
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
  'handoff'
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

  // **`NOT_SWITCHED` 의 `satisfies` 는 이름이 스키마에 있다는 것만 증명한다.** 아홉 번째 이름을
  // 더하면 컴파일도 통과하고 위의 두 단언도 통과한 채, 실제로 치면 501 이 된다 — `case` 도 없고
  // 답하는 가지도 없기 때문이다. 그 반쪽을 여기서 든다: 세 파일 중 한 곳이 그 이름을 실제로
  // 비교하고 있어야 한다(run.ts 의 `parsed.cmd === …`, cli/host.ts 의 허용 목록, command.ts 의
  // switch 앞 `if`). 글자를 보는 약한 증인이지만, 주장과 검사의 차이가 여기 있다.
  it('CLI 가 직접 답한다는 여덟은 실제로 어딘가에서 비교된다', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const answering = ['../../cli/run.ts', '../../cli/host.ts', './command.ts']
      .map((rel) => readFileSync(path.resolve(here, rel), 'utf8'))
      .map((src) =>
        src
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
          .join('\n')
      )
      .join('\n')
    for (const cmd of NOT_SWITCHED)
      expect(answering.includes(`'${cmd}'`), `nothing answers ${cmd}`).toBe(true)
  })
})

// `nextSteps` 는 실행 가능한 명령 줄이라고 약속한다(cliOutput.ts). 손으로 쓴 표가 없는 명령을
// 가리키면 그 약속이 거짓이 되고, 부르는 쪽은 그것을 치고 나서야 안다.
describe('nextSteps 가 가리키는 것은 실재하는 명령이다', () => {
  /** 스키마가 적은 대로 친 모양: `jobs list`, `worker-start`. */
  const spoken = new Set(ctx.commands.map((c) => c.usage.split(' ').slice(1).join(' ')))
  const globals = new Set(ctx.globalFlags.map((f) => `--${f.name}`))

  it('열 코드가 내놓는 모든 줄이 astera 의 실재하는 명령이다', () => {
    const lines = new Set<string>()
    for (const code of CLI_ERROR_CODES)
      for (const cmd of [undefined, ...names]) for (const s of nextStepsFor({ code, cmd })) lines.add(s)
    expect(lines.size).toBeGreaterThan(0)
    for (const line of lines) {
      const tok = line.split(' ')
      expect(tok[0], line).toBe('astera')
      // `astera --help` 는 명령이 아니라 전역 플래그다
      if (globals.has(tok[1])) continue
      const named = [tok.slice(1, 3).join(' '), tok[1]].some((candidate) =>
        [...spoken].some((u) => u === candidate || u.startsWith(`${candidate} `))
      )
      expect(named, `${line} is not a command this CLI has`).toBe(true)
    }
  })
})
