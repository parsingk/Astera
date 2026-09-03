import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import type { Account } from '../types'
import type { PtyFactory, PtyLike, PtySpawnOptions } from './pty'
import { SessionManager, prependToPath } from './manager'
import { buildClaudeCommand, buildCodexCommand } from './commands'
import { makeDescriptors } from '../providers/descriptor'
import { absPath } from '../testPaths'

class FakePty implements PtyLike {
  pid = 4242
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  written: string[] = []
  resized: { cols: number; rows: number }[] = []
  paused = false
  killed = false
  // 호출 횟수 — failsafe 타이머가 "몇 번" resume했는지가 판정 대상이다
  pauseCalls = 0
  resumeCalls = 0
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write(d: string) { this.written.push(d) }
  resize(cols: number, rows: number) { this.resized.push({ cols, rows }) }
  kill() { this.killed = true; this.exitCb({ exitCode: 0 }) }
  pause() { this.paused = true; this.pauseCalls++ }
  resume() { this.paused = false; this.resumeCalls++ }
}

const account: Account = {
  id: 'acc-1', label: 'test', configDir: 'D:\\fake\\config', color: '#fff', createdAt: '2026-07-20T00:00:00Z'
}

const codexAccount: Account = {
  id: 'acc-cx', label: 'codex', configDir: 'C:\\Users\\tester\\.codex-accounts\\work',
  color: '#fff', createdAt: '2026-07-29T00:00:00Z', provider: 'codex'
}

// PtyFactory의 args는 실행 구성 때문에 win32에서 문자열도 받는다(core/run/shell.ts의 shellSpawn).
// SessionManager는 늘 배열을 넘기지만 캡처한 값의 타입은 넓어진 쪽을 따르므로 여기서 흡수한다
const argsText = (args: string[] | string): string => (typeof args === 'string' ? args : args.join(' '))

function setup(highWater = 100, lowWater = 20, homeDir?: string) {
  const spawned: { file: string; args: string[] | string; opts: PtySpawnOptions; pty: FakePty }[] = []
  const factory: PtyFactory = (file, args, opts) => {
    const pty = new FakePty()
    spawned.push({ file, args, opts, pty })
    return pty
  }
  const descriptors = makeDescriptors(process.platform)
  const manager =
    homeDir === undefined
      ? new SessionManager(factory, descriptors, highWater, lowWater)
      : new SessionManager(factory, descriptors, highWater, lowWater, homeDir)
  return { manager, spawned }
}

describe('SessionManager', () => {
  it('spawn은 CLAUDE_CONFIG_DIR를 주입하고 running 세션을 만든다', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account, cwd: process.cwd() })
    expect(spawned[0].opts.env.CLAUDE_CONFIG_DIR).toBe('D:\\fake\\config')
    expect(info.status).toBe('running')
    expect(manager.list().map((s) => s.id)).toEqual([info.id])
  })

  it('기본 계정(configDir가 <home>/.claude)은 CLAUDE_CONFIG_DIR을 주입하지 않는다', () => {
    // claude의 메인 상태(온보딩·oauth·폴더 신뢰)는 홈 루트 ~/.claude.json에 있고
    // CLAUDE_CONFIG_DIR 미설정일 때만 쓰이므로, 기본 계정엔 주입하면 안 된다
    const homeDir = absPath('Users', 'tester')
    const defaultAccount: Account = { ...account, configDir: absPath('Users', 'tester', '.claude') }
    const { manager, spawned } = setup(100, 20, homeDir)
    manager.spawn({ account: defaultAccount, cwd: process.cwd() })
    expect('CLAUDE_CONFIG_DIR' in spawned[0].opts.env).toBe(false)
  })

  it('기본 계정 판정은 경로 대소문자 차이를 무시한다', () => {
    const homeDir = absPath('Users', 'tester')
    const defaultAccount: Account = { ...account, configDir: absPath('Users', 'Tester', '.CLAUDE') }
    const { manager, spawned } = setup(100, 20, homeDir)
    manager.spawn({ account: defaultAccount, cwd: process.cwd() })
    expect('CLAUDE_CONFIG_DIR' in spawned[0].opts.env).toBe(false)
  })

  it('격리 계정(<home>/.claude 아님)은 기존대로 CLAUDE_CONFIG_DIR을 주입한다', () => {
    const homeDir = 'C:\\Users\\tester'
    const isolated: Account = { ...account, configDir: 'C:\\Users\\tester\\.claude-accounts\\foo' }
    const { manager, spawned } = setup(100, 20, homeDir)
    manager.spawn({ account: isolated, cwd: process.cwd() })
    expect(spawned[0].opts.env.CLAUDE_CONFIG_DIR).toBe('C:\\Users\\tester\\.claude-accounts\\foo')
  })

  it('cwd가 없으면 CWD_MISSING 에러를 던진다', () => {
    const { manager } = setup()
    expect(() => manager.spawn({ account, cwd: 'D:\\definitely\\missing\\dir' })).toThrow(/CWD_MISSING/)
  })

  it('resume 세션은 --resume 인자를 붙인다', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: process.cwd(), resumeSessionId: 'sess-9' })
    expect(argsText(spawned[0].args)).toContain('--resume sess-9')
  })

  it('bypassPermissions=true면 --dangerously-skip-permissions 인자를 붙인다', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: process.cwd(), bypassPermissions: true })
    expect(argsText(spawned[0].args)).toContain('--dangerously-skip-permissions')
  })

  it('bypassPermissions 미지정이면 --dangerously-skip-permissions를 붙이지 않는다', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: process.cwd() })
    expect(argsText(spawned[0].args)).not.toContain('--dangerously-skip-permissions')
  })

  it('pty 출력은 onData로, write는 pty로 전달된다', () => {
    const { manager, spawned } = setup()
    const events: string[] = []
    manager.onData = (e) => events.push(e.data)
    const info = manager.spawn({ account, cwd: process.cwd() })
    spawned[0].pty.dataCb('hello')
    manager.write(info.id, 'ls\r')
    expect(events).toEqual(['hello'])
    expect(spawned[0].pty.written).toEqual(['ls\r'])
  })

  it('미확인 바이트가 highWater를 넘으면 pause, ack로 lowWater 아래로 내려가면 resume', () => {
    const { manager, spawned } = setup(100, 20)
    const info = manager.spawn({ account, cwd: process.cwd() })
    spawned[0].pty.dataCb('x'.repeat(150))
    expect(spawned[0].pty.paused).toBe(true)
    manager.ack(info.id, 140)
    expect(spawned[0].pty.paused).toBe(false)
  })

  it('종료 시 status가 exited가 되고 onExit이 발화한다', () => {
    const { manager, spawned } = setup()
    const exits: number[] = []
    manager.onExit = (e) => exits.push(e.exitCode)
    const info = manager.spawn({ account, cwd: process.cwd() })
    spawned[0].pty.exitCb({ exitCode: 7 })
    expect(manager.list()[0].status).toBe('exited')
    expect(manager.list()[0].exitCode).toBe(7)
    expect(exits).toEqual([7])
    expect(info.id).toBe(manager.list()[0].id)
  })

  // exited 세션에는 write·resize가 도달하지 않는다 — kill↔exit 이벤트 사이의
  // 수십 ms 창에서 죽은 pty에 쓰는 경로를 막는다. sessions 맵이 exited 세션도 지우지 않고
  // 보존하므로(list()가 종료된 세션도 돌려준다) 이 창이 실제로 열려 있다.
  it('exit 후 write는 pty에 도달하지 않는다', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account, cwd: process.cwd() })
    spawned[0].pty.exitCb({ exitCode: 0 }) // kill 없이 exit만 먼저 온 상황을 흉내
    manager.write(info.id, 'ls\r')
    expect(spawned[0].pty.written).toEqual([])
  })

  it('exit 후 resize도 pty에 도달하지 않는다', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account, cwd: process.cwd() })
    spawned[0].pty.exitCb({ exitCode: 0 })
    manager.resize(info.id, 100, 40)
    expect(spawned[0].pty.resized).toEqual([])
  })

  it('살아 있는 세션에는 write·resize가 정상 전달된다 (회귀 방지)', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account, cwd: process.cwd() })
    manager.write(info.id, 'ls\r')
    manager.resize(info.id, 100, 40)
    expect(spawned[0].pty.written).toEqual(['ls\r'])
    expect(spawned[0].pty.resized).toEqual([{ cols: 100, rows: 40 }])
  })

  it('buildClaudeCommand는 win32에서 cmd.exe 래퍼를 쓴다', () => {
    expect(buildClaudeCommand('win32')({})).toEqual({ file: 'cmd.exe', args: ['/c', 'claude'] })
    expect(buildClaudeCommand('darwin')({})).toEqual({ file: 'claude', args: [] })
  })

  it('buildCodexCommand는 resume·bypass를 codex 인자로 매핑한다', () => {
    expect(buildCodexCommand('win32')({})).toEqual({ file: 'cmd.exe', args: ['/c', 'codex'] })
    expect(buildCodexCommand('darwin')({ resumeSessionId: 'abc' })).toEqual({
      file: 'codex', args: ['resume', 'abc']
    })
    expect(buildCodexCommand('darwin')({ bypassPermissions: true })).toEqual({
      file: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox']
    })
    // settingsFile(Claude statusLine 전용)은 무시된다
    expect(buildCodexCommand('darwin')({ settingsFile: 's.json' })).toEqual({ file: 'codex', args: [] })
  })

  it('buildCodexCommand는 resumePrompt를 resume 뒤 인자로 붙인다', () => {
    expect(
      buildCodexCommand('darwin')({ resumeSessionId: 'abc', resumePrompt: '이어서 작업 진행해 줘' })
    ).toEqual({ file: 'codex', args: ['resume', 'abc', '이어서 작업 진행해 줘'] })
    // resume 없이 프롬프트만 오면 무시한다 (새 세션에 프롬프트를 꽂지 않는다)
    expect(buildCodexCommand('darwin')({ resumePrompt: 'x' })).toEqual({ file: 'codex', args: [] })
  })

  // 리뷰 지적: win32는 cmd.exe /c 래퍼라 node-pty의 MSVCRT 인용(\")이 cmd에는 통하지 않는다.
  // 따옴표가 든 프롬프트는 기동 실패(=전환 순간 탭이 죽는다), 공백 없는 &·| 는 cmd가 분리 실행한다.
  it('buildCodexCommand는 프롬프트의 셸 메타문자를 지운다 (cmd.exe 주입·인용 깨짐 방지)', () => {
    const meta = buildCodexCommand('win32')({
      resumeSessionId: 'abc',
      resumePrompt: '계속"하기" & 정리 | 끝 > out < in ^esc'
    })
    expect(meta.args).toEqual(['/c', 'codex', 'resume', 'abc', '계속 하기 정리 끝 out in esc'])
    // 공백 없이 붙은 메타문자도 분리 실행 경로가 사라진다
    expect(
      buildCodexCommand('win32')({ resumeSessionId: 'abc', resumePrompt: '계속&정리' }).args.at(-1)
    ).toBe('계속 정리')
    // 줄바꿈도 cmd 커맨드라인을 끊는다
    expect(
      buildCodexCommand('darwin')({ resumeSessionId: 'abc', resumePrompt: '이어서\r\n진행' }).args.at(-1)
    ).toBe('이어서 진행')
  })

  // cmd.exe의 %VAR% 퍼센트 확장은 메타문자 처리보다 먼저 일어나 &·| 없이도 분리 실행을 되살릴 수 있고,
  // 악의가 없어도 환경변수 값으로 조용히 치환된 문장이 codex에 전달된다.
  it('buildCodexCommand는 프롬프트의 %를 지워 cmd.exe 퍼센트 확장을 막는다 (보안 갭)', () => {
    expect(
      buildCodexCommand('win32')({ resumeSessionId: 'abc', resumePrompt: '전%달' }).args.at(-1)
    ).not.toContain('%')
    // %VAR% 형태는 %가 사라져 짝이 깨지므로 cmd가 확장할 수 있는 %...% 토큰이 남지 않는다
    const expanded = buildCodexCommand('win32')({
      resumeSessionId: 'abc',
      resumePrompt: 'hello%USERNAME%world'
    }).args.at(-1)
    expect(expanded).not.toMatch(/%[^%]*%/)
  })

  it('buildCodexCommand는 정상 프롬프트를 그대로 싣고, 메타문자만 남으면 인자를 빼버린다', () => {
    expect(
      buildCodexCommand('darwin')({ resumeSessionId: 'abc', resumePrompt: '이어서 작업 진행해 줘' }).args
    ).toEqual(['resume', 'abc', '이어서 작업 진행해 줘'])
    expect(buildCodexCommand('win32')({ resumeSessionId: 'abc', resumePrompt: ' && ' }).args).toEqual([
      '/c', 'codex', 'resume', 'abc'
    ])
  })

  it('buildClaudeCommand는 resumePrompt를 무시한다 (codex 전용 인자)', () => {
    expect(buildClaudeCommand('darwin')({ resumeSessionId: 'abc', resumePrompt: 'x' })).toEqual({
      file: 'claude',
      args: ['--resume', 'abc']
    })
  })

  it('spawn이 resumePrompt를 codex 커맨드로 전달한다', () => {
    const { manager, spawned } = setup(100, 20, 'C:\\Users\\tester')
    manager.spawn({
      account: codexAccount,
      cwd: process.cwd(),
      resumeSessionId: 'cx-sess',
      resumePrompt: '이어서'
    })
    expect([spawned[0].file, ...spawned[0].args].join(' ')).toContain('이어서')
  })

  it('codex 계정 spawn은 CODEX_HOME을 주입하고 codex 커맨드를 쓴다', () => {
    const { manager, spawned } = setup(100, 20, 'C:\\Users\\tester')
    manager.spawn({ account: codexAccount, cwd: process.cwd() })
    expect(spawned[0].opts.env.CODEX_HOME).toBe('C:\\Users\\tester\\.codex-accounts\\work')
    // 플랫폼에 따라 file='codex' 또는 cmd.exe 래퍼라 둘을 합쳐 검사한다
    expect([spawned[0].file, ...spawned[0].args].join(' ')).toContain('codex')
  })

  it('ambient codex 계정(~/.codex)은 CODEX_HOME을 주입하지 않는다', () => {
    const ambient: Account = { ...codexAccount, configDir: absPath('Users', 'Tester', '.CODEX') }
    const { manager, spawned } = setup(100, 20, absPath('Users', 'tester'))
    manager.spawn({ account: ambient, cwd: process.cwd() })
    expect('CODEX_HOME' in spawned[0].opts.env).toBe(false)
  })

  it('codex 세션에는 statusLine provider를 태우지 않는다', () => {
    const calls: string[] = []
    const manager = new SessionManager(
      () => new FakePty(),
      makeDescriptors('win32'), 100, 20, 'C:\\Users\\tester',
      (id) => { calls.push(id); return null }
    )
    manager.spawn({ account: codexAccount, cwd: process.cwd() })
    expect(calls).toEqual([])
  })

  it('codex 단독 롤링 체인은 허용한다', () => {
    const { manager } = setup(100, 20, 'C:\\Users\\tester')
    expect(() =>
      manager.spawn({
        account: codexAccount,
        cwd: process.cwd(),
        rollAccountIds: [codexAccount.id, 'acc-cx2']
      })
    ).not.toThrow()
  })

  it('혼합 프로바이더 롤링은 ROLL_MIXED_PROVIDER로 거부한다', () => {
    const { manager } = setup(100, 20, 'C:\\Users\\tester')
    // spawn은 계정 객체 하나만 받으므로, 혼합 판정은 rollProviders로 넘긴 목록으로 한다
    expect(() =>
      manager.spawn({
        account: codexAccount,
        cwd: process.cwd(),
        rollAccountIds: ['a', 'b'],
        rollProviders: ['codex', 'claude']
      })
    ).toThrow(/ROLL_MIXED_PROVIDER/)
  })

  it('rollProviders가 전부 같으면 통과한다', () => {
    const { manager } = setup(100, 20, 'C:\\Users\\tester')
    expect(() =>
      manager.spawn({
        account: codexAccount,
        cwd: process.cwd(),
        rollAccountIds: ['a', 'b'],
        rollProviders: ['codex', 'codex']
      })
    ).not.toThrow()
  })

  it('rollAccountIds는 SessionInfo에 그대로 보존된다', () => {
    const { manager } = setup()
    const info = manager.spawn({ account, cwd: process.cwd(), rollAccountIds: ['acc-1', 'acc-2'] })
    expect(info.rollAccountIds).toEqual(['acc-1', 'acc-2'])
    expect(manager.list()[0].rollAccountIds).toEqual(['acc-1', 'acc-2'])
  })

  it('rollPrompt는 SessionInfo에 그대로 보존된다', () => {
    const { manager } = setup()
    const info = manager.spawn({ account, cwd: process.cwd(), rollPrompt: '계속 이어가 줘' })
    expect(info.rollPrompt).toBe('계속 이어가 줘')
    expect(manager.list()[0].rollPrompt).toBe('계속 이어가 줘')
  })

  it('slackNotify=true면 provider에 hooks 옵션을 넘기고 ASTERA_HOOK_OUT을 주입한다', () => {
    const spawned: { opts: PtySpawnOptions }[] = []
    const factory: PtyFactory = (_f, _a, opts) => {
      spawned.push({ opts })
      return new FakePty()
    }
    const hookCalls: ({ toolHooks?: boolean } | undefined)[] = []
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, undefined, (id, _acc, o) => {
      hookCalls.push(o)
      return {
        settingsFile: 's.json',
        outPath: 'o.json',
        originalCommand: null,
        hookOutPath: `D:/tmp/hook-events/${id}.jsonl` // 실제 spawnConfig 와 같이 항상 준다
      }
    })
    const info = manager.spawn({ account, cwd: process.cwd(), slackNotify: true })
    expect(hookCalls[0]?.toolHooks).toBe(true)
    expect(spawned[0].opts.env.ASTERA_HOOK_OUT).toContain(info.id)
    expect(info.slackNotify).toBe(true)
    expect(manager.list()[0].slackNotify).toBe(true)
  })

  // slackNotify 도 롤링도 없는 평범한 세션이다. 도구 캡처(toolHooks)는 안 들어가지만
  // ASTERA_HOOK_OUT 은 들어가야 한다 — Stop·Notification 훅은 모든 세션에 심기고, 그 훅이 쓸
  // 경로가 없으면 캡처 스크립트가 아무 일도 하지 않아 심으나 마나가 된다. 데스크톱 알림이 보통
  // 세션에서 한 번도 오지 않았던 원인이 정확히 이것이다.
  it('평범한 세션도 ASTERA_HOOK_OUT 을 받는다 (toolHooks 는 false)', () => {
    const spawned: { opts: PtySpawnOptions }[] = []
    const hookCalls: ({ toolHooks?: boolean } | undefined)[] = []
    const factory: PtyFactory = (_f, _a, opts) => {
      spawned.push({ opts })
      return new FakePty()
    }
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, undefined, (id, _acc, o) => {
      hookCalls.push(o)
      return {
        settingsFile: 's.json',
        outPath: 'o.json',
        originalCommand: null,
        hookOutPath: `D:/tmp/hook-events/${id}.jsonl` // 실제 spawnConfig 와 같이 항상 준다
      }
    })
    const info = manager.spawn({ account, cwd: process.cwd() })
    expect(hookCalls[0]?.toolHooks).toBe(false)
    expect(spawned[0].opts.env.ASTERA_HOOK_OUT).toContain('hook-events/')
    expect(info.slackNotify).toBeUndefined()
  })

  // 위 단정과 같은 구멍이 여기에도 있다 — 상속 환경에 ASTERA_HOOK_OUT이 있으면 `in === false`가
  // 깨진다. 지금은 이 변수가 개발 환경에 보통 없어서 드러나지 않았을 뿐이다(orchEnv 블록의
  // ASTERA_CLI는 실제로 그렇게 깨졌다). 상속값을 심어 프로덕션이 지우는지 본다.
  it('상속된 ASTERA_HOOK_OUT·STATUSLINE 경로는 세션으로 넘기지 않는다', () => {
    // 남의 인스턴스의 캡처 파일을 가리키는 값이 새 세션에 그대로 흐르면, 이 세션의 hook·statusline
    // 출력이 다른 인스턴스의 파일에 섞여 들어간다
    vi.stubEnv('ASTERA_HOOK_OUT', 'C:/other-instance/hook-events/xxx.jsonl')
    vi.stubEnv('ASTERA_STATUSLINE_OUT', 'C:/other-instance/statusline/xxx.json')
    vi.stubEnv('ASTERA_STATUSLINE_ORIGINAL', 'other-hud --json')
    const spawned: { opts: PtySpawnOptions }[] = []
    const factory: PtyFactory = (_f, _a, opts) => {
      spawned.push({ opts })
      return new FakePty()
    }
    // statusLineProvider 없음 = sl이 null이라 주입 분기를 타지 않는다 (codex 세션과 같은 상태)
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20)
    manager.spawn({ account, cwd: process.cwd() })
    expect('ASTERA_HOOK_OUT' in spawned[0].opts.env).toBe(false)
    expect('ASTERA_STATUSLINE_OUT' in spawned[0].opts.env).toBe(false)
    expect('ASTERA_STATUSLINE_ORIGINAL' in spawned[0].opts.env).toBe(false)
    vi.unstubAllEnvs()
  })

  // idle nudge가 Notification 훅을 신호로 쓰므로 롤링 세션에도 훅이 필요하다.
  // 종전에는 slackNotify 세션에만 주입돼 슬랙을 끈 롤링 세션은 신호를 받을 수 없었다.
  it('롤링 세션은 slackNotify가 꺼져 있어도 toolHooks=true로 주입한다', () => {
    const factory: PtyFactory = () => new FakePty()
    const hookCalls: ({ toolHooks?: boolean } | undefined)[] = []
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, undefined, (id, _acc, o) => {
      hookCalls.push(o)
      return {
        settingsFile: 's.json',
        outPath: 'o.json',
        originalCommand: null,
        hookOutPath: `D:/tmp/hook-events/${id}.jsonl` // 실제 spawnConfig 와 같이 항상 준다
      }
    })
    manager.spawn({ account, cwd: process.cwd(), rollAccountIds: ['a1', 'a2'] })
    expect(hookCalls[0]?.toolHooks).toBe(true)
  })

  // opts.rollAccountIds?.length ?? 0) >= 1을 "배열이 truthy면 롤링"으로 잘못
  // 단순화하면 빈 배열([])도 통과해 모든 세션에 훅이 주입된다 — 이 회귀를 잡아 둔다.
  it('rollAccountIds가 빈 배열이면 롤링으로 치지 않는다 (toolHooks=false)', () => {
    const factory: PtyFactory = () => new FakePty()
    const hookCalls: ({ toolHooks?: boolean } | undefined)[] = []
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, undefined, (id, _acc, o) => {
      hookCalls.push(o)
      return {
        settingsFile: 's.json',
        outPath: 'o.json',
        originalCommand: null,
        hookOutPath: `D:/tmp/hook-events/${id}.jsonl` // 실제 spawnConfig 와 같이 항상 준다
      }
    })
    manager.spawn({ account, cwd: process.cwd(), rollAccountIds: [] })
    expect(hookCalls[0]?.toolHooks).toBe(false)
  })

  it('롤링도 slackNotify도 없으면 toolHooks=false', () => {
    const factory: PtyFactory = () => new FakePty()
    const hookCalls: ({ toolHooks?: boolean } | undefined)[] = []
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, undefined, (id, _acc, o) => {
      hookCalls.push(o)
      return {
        settingsFile: 's.json',
        outPath: 'o.json',
        originalCommand: null,
        hookOutPath: `D:/tmp/hook-events/${id}.jsonl` // 실제 spawnConfig 와 같이 항상 준다
      }
    })
    manager.spawn({ account, cwd: process.cwd() })
    expect(hookCalls[0]?.toolHooks).toBe(false)
  })

  it('spawn이 initialPrompt를 커맨드의 마지막 위치 인자로 전달한다', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: process.cwd(), initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(spawned[0].args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })

  it('initialPrompt 미지정이면 인자가 늘지 않는다 (안전 조건)', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: process.cwd() })
    expect(spawned[0].args).toEqual(buildClaudeCommand(process.platform)({}).args)
  })

  // 워커 탭 제목 (UI 변경 없음 — 제목만 task.title을 쓴다)
  it('title을 주면 SessionInfo.title이 그 값이다', () => {
    const { manager } = setup()
    const info = manager.spawn({ account, cwd: process.cwd(), title: '인증 리팩터' })
    expect(info.title).toBe('인증 리팩터')
    expect(manager.list()[0].title).toBe('인증 리팩터')
  })

  it('title을 생략하면 cwd basename을 쓴다 (기존 동작 회귀 방어)', () => {
    const { manager } = setup()
    const info = manager.spawn({ account, cwd: process.cwd() })
    expect(info.title).toBe(path.basename(process.cwd()))
  })

  // pause는 영구적일 수 없다 (lost-resume 안전망).
  // pendingBytes를 줄이는 유일한 경로가 렌더러 TerminalView의 ack이므로, 탭이 없는 세션
  // (오케스트레이션 워커)은 highWater를 넘긴 뒤 ack를 영원히 받지 못해 영구 정지했다.
  describe('pause 자동 해제 failsafe', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('ack가 한 번도 오지 않아도 failsafe 시간이 지나면 resume된다', () => {
      const { manager, spawned } = setup(100, 20)
      manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      expect(spawned[0].pty.paused).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(spawned[0].pty.paused).toBe(false)
      expect(spawned[0].pty.resumeCalls).toBe(1)
    })

    it('failsafe resume 후 pendingBytes가 0이라 다음 청크에 즉시 다시 pause되지 않는다', () => {
      // 이 단정이 manager.ts의 `live.pendingBytes = 0`을 지킨다 — 없으면 카운터가 150에 남아
      // 다음 청크가 곧바로 highWater를 넘겨 5초마다 한 청크만 흐르는 상태가 된다
      const { manager, spawned } = setup(100, 20)
      manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      vi.advanceTimersByTime(5_000)
      spawned[0].pty.dataCb('y'.repeat(10))
      expect(spawned[0].pty.pauseCalls).toBe(1)
      expect(spawned[0].pty.paused).toBe(false)
    })

    it('ack로 정상 resume되면 failsafe 타이머가 취소된다', () => {
      const { manager, spawned } = setup(100, 20)
      const info = manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      manager.ack(info.id, 140)
      expect(spawned[0].pty.resumeCalls).toBe(1)
      vi.advanceTimersByTime(30_000)
      expect(spawned[0].pty.resumeCalls).toBe(1) // 안 취소하면 두 번 불린다
    })

    it('세션이 종료되면 타이머가 죽은 PTY를 건드리지 않는다', () => {
      const { manager, spawned } = setup(100, 20)
      manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      expect(spawned[0].pty.paused).toBe(true)
      spawned[0].pty.exitCb({ exitCode: 0 })
      vi.advanceTimersByTime(30_000)
      expect(spawned[0].pty.resumeCalls).toBe(0)
    })

    // ack가 오지만 lowWater까지 못 내려가는 소비자는 "없는" 것이 아니라 "느린" 것이다.
    // 그 세션의 카운터를 0으로 지우면 backpressure가 사실상 꺼지고, 폭주하는 자식이 xterm의
    // WriteBuffer 한도(5e7)에 닿아 데이터가 버려진다
    it('ack가 왔지만 lowWater 위에 머물면 failsafe가 카운터를 지우지도 resume하지도 않는다', () => {
      const { manager, spawned } = setup(100, 20)
      const info = manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      expect(spawned[0].pty.paused).toBe(true)
      manager.ack(info.id, 10) // 140 — lowWater(20) 위에 머문다
      vi.advanceTimersByTime(5_000)
      expect(spawned[0].pty.resumeCalls).toBe(0)
      expect(spawned[0].pty.paused).toBe(true) // 스로틀 유지
    })

    it('그 뒤 창마다 ack가 계속 오면 계속 재무장한다 (스로틀 유지)', () => {
      const { manager, spawned } = setup(100, 20)
      const info = manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      manager.ack(info.id, 10)
      vi.advanceTimersByTime(5_000) // 1차 창: ack 있음 → 재무장
      manager.ack(info.id, 10)
      vi.advanceTimersByTime(5_000) // 2차 창: ack 있음 → 재무장
      expect(spawned[0].pty.resumeCalls).toBe(0)
      expect(spawned[0].pty.paused).toBe(true)
      // 그러나 창 하나가 통째로 조용하면(소비자가 사라졌다) 해제된다 — C1이 되돌아오지 않는다
      vi.advanceTimersByTime(5_000)
      expect(spawned[0].pty.resumeCalls).toBe(1)
      expect(spawned[0].pty.paused).toBe(false)
    })

    it('pause가 다시 걸리면 타이머도 다시 걸린다 (재무장)', () => {
      // 다시 pause하면 안전망도 다시 무장한다 — 두 번째 pause도 5초 뒤에 스스로 풀려야 한다
      const { manager, spawned } = setup(100, 20)
      manager.spawn({ account, cwd: process.cwd() })
      spawned[0].pty.dataCb('x'.repeat(150))
      vi.advanceTimersByTime(5_000) // 1차 failsafe resume
      spawned[0].pty.dataCb('x'.repeat(150)) // 다시 highWater 초과 → 2차 pause
      expect(spawned[0].pty.paused).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(spawned[0].pty.paused).toBe(false)
      expect(spawned[0].pty.resumeCalls).toBe(2)
    })
  })

  describe('orchEnv 주입', () => {
    const orchEnv = {
      cliPath: 'C:/cli/astera.cmd',
      infoPath: 'C:/u/info.json',
      skillsPath: 'C:/u/skills'
    }

    it('ASTERA_* 네 개를 주입한다 (CLI·INFO·SKILLS·SESSION)', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_CLI).toBe('C:/cli/astera.cmd')
      expect(spawned[0].opts.env.ASTERA_INFO).toBe('C:/u/info.json')
      // help가 이 디렉토리에서 orchestration-guide.md를 읽는다 (src/cli/run.ts resolveGuidePath)
      expect(spawned[0].opts.env.ASTERA_SKILLS).toBe('C:/u/skills')
      expect(spawned[0].opts.env.ASTERA_SESSION).toBeTruthy()
    })

    it('같은 orchEnv로 두 세션을 띄우면 ASTERA_SESSION만 서로 다르다', () => {
      // 서버는 이 값으로 호출자 신원을 판정한다 — 겹치면 한 세션이 다른 세션의
      // dispatch로 보고할 수 있다
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_SESSION).not.toBe(spawned[1].opts.env.ASTERA_SESSION)
      expect(spawned[1].opts.env.ASTERA_CLI).toBe(spawned[0].opts.env.ASTERA_CLI)
    })

    /* 상속 환경을 세우지 않으면 이 아래 "지운다" 단정이 양방향으로 무의미해진다 —
     *  main/core.test.ts 상단이 같은 함정을 이미 문서화했다. spawn은 `{ ...process.env }`로
     *  시작하므로:
     *   - 상속 환경에 값이 **없으면** manager.ts의 delete 줄을 지워도 초록불이다(CI가 그렇다).
     *   - 값이 **있으면** 늘 빨간불이었다 — Astera 세션 안에서 테스트를 돌리는 개발자의 일상이고,
     *     실제로 이 파일이 그렇게 깨져 있었다.
     *  그래서 상속 값을 직접 심고 "지워지는지"까지 본다. */
    const INHERITED = {
      ASTERA_CLI: 'C:/other-instance/orch/astera.cmd',
      ASTERA_INFO: 'C:/other-instance/orch/orch-info.json',
      ASTERA_SKILLS: 'C:/other-instance/skills',
      ASTERA_SESSION: 'inherited-session-id'
    }
    const stubInherited = (): void => {
      for (const [k, v] of Object.entries(INHERITED)) vi.stubEnv(k, v)
    }
    afterEach(() => vi.unstubAllEnvs())

    it('orchEnv가 없으면 상속된 ASTERA_*까지 지운다', () => {
      // 앱을 Astera 세션의 셸에서 띄우면(`npm run dev`가 그 경로다) 앱 프로세스가 **다른
      // 인스턴스의** ASTERA_CLI·INFO를 물고 시작한다. 그것이 그대로 새 세션에 상속되면
      // orchestration을 끈 세션의 에이전트가 남의 인스턴스 서버와 토큰을 쥐게 되고,
      // 상속된 ASTERA_SESSION은 남의 세션 신원으로 보고하게 만든다.
      // 넣지 않는 것으로는 부족하고 지워야 한다 — configDirEnv와 main/core.ts의 규약이 같다.
      stubInherited()
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      for (const k of Object.keys(INHERITED)) {
        expect(k in spawned[0].opts.env).toBe(false)
      }
    })

    it('orchEnv가 있으면 상속값이 아니라 orchEnv 값이 이긴다', () => {
      stubInherited()
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_CLI).toBe('C:/cli/astera.cmd')
      expect(spawned[0].opts.env.ASTERA_INFO).toBe('C:/u/info.json')
      expect(spawned[0].opts.env.ASTERA_SKILLS).toBe('C:/u/skills')
      expect(spawned[0].opts.env.ASTERA_SESSION).toBe(info.id) // 상속된 남의 세션 id가 아니다
    })

    it('ASTERA_SESSION은 그 세션의 id와 같다', () => {
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_SESSION).toBe(info.id)
    })

    // 세션 PATH에 셔틀 디렉토리 붙이기 — 이것이 `astera`를 명령어로 만든다.
    // 대소문자를 구분해 키를 찾는다: win32의 process.env는 보통 `Path`로 주고, pty.spawn에
    // 넘기는 평범한 객체는 대소문자를 구분한다.
    const pathKeysOf = (env: Record<string, string | undefined>): string[] =>
      Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')

    it('orchEnv가 있으면 PATH 앞에 셔틀 디렉토리가 붙는다', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      const keys = pathKeysOf(spawned[0].opts.env)
      expect(keys).toHaveLength(1) // 키를 새로 만들지 않았다
      expect(spawned[0].opts.env[keys[0]]).toContain(`C:/cli${path.delimiter}`)
      expect(spawned[0].opts.env[keys[0]]!.startsWith(`C:/cli${path.delimiter}`)).toBe(true)
    })

    it('기존 PATH 값이 보존된다 — 붙이기만 하고 덮어쓰지 않는다', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      const key = pathKeysOf(spawned[0].opts.env)[0]
      const original = process.env[key]
      expect(original).toBeTruthy()
      expect(spawned[0].opts.env[key]).toBe(`C:/cli${path.delimiter}${original}`)
    })

    it('orchEnv가 없으면 PATH가 한 글자도 바뀌지 않는다', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      const keys = pathKeysOf(spawned[0].opts.env)
      expect(keys).toHaveLength(1)
      expect(spawned[0].opts.env[keys[0]]).toBe(process.env[keys[0]])
    })

    it('기존 키가 Path면 Path를 갱신하고 PATH를 새로 만들지 않는다 (win32 실제 형태)', () => {
      // 이것만 prependToPath를 직접 부른다 — process.env의 키 대소문자는 OS가 정하므로
      // spawn 경로로는 win32의 `Path` 형태를 결정적으로 재현할 수 없다.
      const env: Record<string, string | undefined> = { Path: 'C:\\Windows', OTHER: 'x' }
      prependToPath(env, 'C:\\shuttle')
      expect(env.Path).toBe(`C:\\shuttle${path.delimiter}C:\\Windows`)
      expect('PATH' in env).toBe(false)
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1)
    })

    it('PATH가 아예 없으면 셔틀 디렉토리만 세운다 — 빈 항목(선행 구분자)을 남기지 않는다', () => {
      const env: Record<string, string | undefined> = {}
      prependToPath(env, 'C:\\shuttle')
      expect(env.PATH).toBe('C:\\shuttle')
    })
  })
})
