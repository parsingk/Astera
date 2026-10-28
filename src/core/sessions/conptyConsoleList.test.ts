import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceConsoleProcessList, type ConsoleListAgent } from './conptyConsoleList'

class FakeAgent extends EventEmitter implements ConsoleListAgent {
  killed = 0
  kill(): boolean {
    this.killed++
    return true
  }
}

/** node-pty 의 WindowsPtyAgent 모양만 흉내낸 것: 원본 _getConsoleProcessList 는 5 초 뒤 [innerPid] 를 낸다. */
function fakeTerm(over: Record<string, unknown> = {}): { _agent: Record<string, unknown> } {
  return {
    _agent: {
      _useConpty: true,
      _useConptyDll: false,
      _innerPid: 4321,
      _getConsoleProcessList: () => Promise.resolve([4321]),
      ...over
    }
  }
}

function install(term: unknown, agents: FakeAgent[], platform = 'win32') {
  const forked: number[] = []
  const done = replaceConsoleProcessList(term, platform, (pid) => {
    forked.push(pid)
    const a = new FakeAgent()
    agents.push(a)
    return a
  })
  return { done, forked }
}

function list(term: { _agent: Record<string, unknown> }): Promise<number[]> {
  return (term._agent._getConsoleProcessList as () => Promise<number[]>)()
}

describe('replaceConsoleProcessList', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("resolves the agent's list when it answers, and forks it on the shell's pid", async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    const { done, forked } = install(term, agents)
    expect(done).toBe(true)
    const p = list(term)
    expect(forked).toEqual([4321])
    agents[0].emit('message', { consoleProcessList: [4321, 77] })
    await expect(p).resolves.toEqual([4321, 77])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves [] when the channel closes without an answer (AttachConsole failed), not the shell pid', async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('exit', 1, null)
    agents[0].emit('disconnect')
    await expect(p).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps a list the agent wrote even when 'exit' is seen before its 'message'", async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('exit', 0, null)
    agents[0].emit('message', { consoleProcessList: [4321, 88] })
    agents[0].emit('disconnect')
    await expect(p).resolves.toEqual([4321, 88])
  })

  it("an exit alone settles nothing: the timeout covers an agent whose channel never closes", async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(4999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toEqual([])
    expect(agents[0].killed).toBe(1)
  })

  it('resolves [] on a fork error', async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('error', new Error('spawn failed'))
    await expect(p).resolves.toEqual([])
  })

  it('resolves [] when fork itself throws', async () => {
    const term = fakeTerm()
    replaceConsoleProcessList(term, 'win32', () => {
      throw new Error('no fork')
    })
    await expect(list(term)).resolves.toEqual([])
  })

  it('resolves [] at the 5 s timeout and kills the agent', async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    await vi.advanceTimersByTimeAsync(4999)
    expect(agents[0].killed).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toEqual([])
    expect(agents[0].killed).toBe(1)
  })

  it('settles once: a disconnect after the answer, or a late answer after the disconnect, changes nothing', async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('message', { consoleProcessList: [9] })
    agents[0].emit('disconnect')
    agents[0].emit('message', { consoleProcessList: [1] })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toEqual([9])
    expect(agents[0].killed).toBe(0)

    const q = list(term)
    agents[1].emit('disconnect')
    agents[1].emit('message', { consoleProcessList: [5] })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(q).resolves.toEqual([])
    expect(agents[1].killed).toBe(0)
  })

  it('treats a message without a list as no list', async () => {
    const term = fakeTerm()
    const agents: FakeAgent[] = []
    install(term, agents)
    const p = list(term)
    agents[0].emit('message', {})
    await expect(p).resolves.toEqual([])
  })

  describe('leaves the instance alone, without throwing, unless it is ConPTY without the DLL on win32', () => {
    const cases: [string, unknown, string][] = [
      ['not win32', fakeTerm(), 'linux'],
      ['no _agent', {}, 'win32'],
      ['null', null, 'win32'],
      ['_agent without the method', fakeTerm({ _getConsoleProcessList: undefined }), 'win32'],
      ['winpty', fakeTerm({ _useConpty: false }), 'win32'],
      ['conpty DLL', fakeTerm({ _useConptyDll: true }), 'win32'],
      ['no inner pid', fakeTerm({ _innerPid: undefined }), 'win32']
    ]
    for (const [name, term, platform] of cases) {
      it(name, () => {
        const before = (term as { _agent?: { _getConsoleProcessList?: unknown } } | null)?._agent?._getConsoleProcessList
        expect(replaceConsoleProcessList(term, platform, () => new FakeAgent())).toBe(false)
        expect((term as { _agent?: { _getConsoleProcessList?: unknown } } | null)?._agent?._getConsoleProcessList).toBe(before)
      })
    }
  })
})

// 이 교체는 node-pty 1.1.0 의 windowsPtyAgent.js 모양에 기댄다: kill() 이 _getConsoleProcessList() 를 부르고
// 곧바로 pseudoconsole 을 닫는 것, 그리고 그 함수가 timeout 에 resolve([_this._innerPid]) 로 떨어지는 것.
// node-pty 를 올리면 이 테스트가 깨져서, 교체가 여전히 맞는지 사람이 다시 보게 한다.
describe('node-pty windowsPtyAgent.js pin', () => {
  const lib = path.dirname(createRequire(__filename).resolve('node-pty'))
  const src = readFileSync(path.join(lib, 'windowsPtyAgent.js'), 'utf8')

  it('still has _getConsoleProcessList with the blind [innerPid] fallback', () => {
    expect(src).toContain('WindowsPtyAgent.prototype._getConsoleProcessList = function')
    expect(src).toContain('resolve([_this._innerPid])')
  })

  it('kill() still lists first and then closes the pseudoconsole, killing every listed pid', () => {
    expect(src).toMatch(/this\._getConsoleProcessList\(\)\.then\(function \(consoleProcessList\)/)
    expect(src).toContain('process.kill(pid)')
    expect(src).toContain('this._ptyNative.kill(this._pty, this._useConptyDll)')
  })

  it('still forks the list agent that exists beside it', () => {
    expect(src).toContain("path.join(__dirname, 'conpty_console_list_agent')")
    expect(readFileSync(path.join(lib, 'conpty_console_list_agent.js'), 'utf8')).toContain('process.send({ consoleProcessList')
  })
})
