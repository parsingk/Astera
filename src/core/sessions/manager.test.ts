import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../types'
import { PTY_LOST_SIGHT_EXIT_CODE, type PtyFactory, type PtyLike, type PtySpawnOptions } from './pty'
import { SessionManager, EXITED_SESSIONS_KEPT, prependToPath, type SpawnChecks } from './manager'
import { createGitBashResolver } from './gitBash'
import { PROBE_CACHE_TTL_MS, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, PathKeyedCache, createProbePool, createProber } from './pathProbe'
import { buildClaudeCommand, buildCodexCommand } from './commands'
import { makeDescriptors } from '../providers/descriptor'
import { absPath, foldsCaseHere } from '../testPaths'
import type { RollSnapshot, RollSpawnExtra } from '../rolling/snapshot'
import type { SessionCapabilities } from '../extensions/resolve'
import { sessionInfoFromNote } from './noteInfo'
import { gitLayoutOf } from '../sandbox/gitLayout'
import { appKeyDenies, credentialStoreDenies, nodeLinkLook, profileReadOnly, sensitiveLocations } from '../sandbox/locations'
import { appKeyPath } from '../host/hostKey'
import { codexSandboxArgs, codexSandboxEnv, npmCacheOf } from '../sandbox/codexProfile'
import { claudeSandboxSettings } from '../sandbox/claudeSettings'
import type { GitLayout } from '../sandbox/gitLayout'
import { claudeSandboxStart, gitExcludesFileOf, gitExcludesText } from '../sandbox/claudeStart'
import { StatusLineManager } from './statusline'
import { srtConfigOf, type SrtCheckPayload } from '../sandbox/srtCheck'
import { CHECK_STARTED_MARK, CODEX_CHECK_FLAG, codexCheckRunner } from '../sandbox/checkRunner'

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
  /** The note patches this pty was asked to keep — what a Host-backed pty sends as pty-note. */
  remembered: Record<string, unknown>[] = []
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  /** Which writes came marked as typed by a person in the tab (`PtyLike.write`'s second argument). */
  typed: boolean[] = []
  write(d: string, by?: { typed: true }) { this.written.push(d); this.typed.push(by?.typed === true) }
  resize(cols: number, rows: number) { this.resized.push({ cols, rows }) }
  kill() { this.killed = true; this.exitCb({ exitCode: 0 }) }
  pause() { this.paused = true; this.pauseCalls++ }
  resume() { this.paused = false; this.resumeCalls++ }
  remember(patch: Record<string, unknown>) { this.remembered.push(patch) }
  emitExit(exitCode: number) { this.exitCb({ exitCode }) }
  /** What `createPtyRouter` stamps on a real handle — set by the tests that care which
   *  factory made the pty. Absent is a pty this process owns, which is what the router
   *  writes with no Host and what every other test here wants. */
  outlivesApp?: boolean
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

// Second pass M2-5: the app kept every exited terminal session for its whole life, and every orchestration fold, busy
// change and Slack write copies the list.
describe('exited sessions kept', () => {
  it('keeps the newest EXITED_SESSIONS_KEPT exited sessions', () => {
    const { manager, spawned } = setup()
    const ids: string[] = []
    for (let i = 0; i < EXITED_SESSIONS_KEPT + 2; i++) {
      ids.push(manager.spawn({ account, cwd: process.cwd() }).id)
      spawned[i].pty.emitExit(0)
    }
    const live = manager.spawn({ account, cwd: process.cwd() }).id
    const listed = manager.list().map((s) => s.id)
    expect(listed).toHaveLength(EXITED_SESSIONS_KEPT + 1)
    expect(listed).not.toContain(ids[1])
    expect(listed).toContain(ids[2])
    expect(listed).toContain(live)
  })
})

describe('SessionManager', () => {
  // 탭 라벨은 SessionInfo.title 하나를 읽고, Slack 접두사와 데스크톱 알림 제목도 같은 값을 읽는다.
  // 그래서 이름 변경은 여기 한 곳만 갱신하면 세 자리가 함께 따라온다.
  describe('rename', () => {
    it('제목을 바꾸고 바뀐 값을 돌려준다', () => {
      const { manager } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      expect(manager.rename(info.id, '  결제  리팩터링 ')).toBe('결제 리팩터링')
      expect(manager.list().find((s) => s.id === info.id)?.title).toBe('결제 리팩터링')
    })

    // 입력칸을 비우는 것이 기본 이름을 되찾는 유일한 방법이다
    it('빈 이름은 프로젝트 폴더 이름으로 되돌린다', () => {
      const { manager } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      const dflt = info.title
      manager.rename(info.id, '결제')
      expect(manager.rename(info.id, '   ')).toBe(dflt)
      expect(manager.list().find((s) => s.id === info.id)?.title).toBe(dflt)
    })

    // 이미 죽은 세션의 탭도 목록에 남아 있으므로(list 는 exited 도 낸다) 부를 수 있는 자리다.
    // 없는 id 는 조용히 아무것도 하지 않는다 — 탭이 사라지는 것과 이름 변경이 겹칠 수 있다.
    it('모르는 세션 id 는 조용히 무시한다', () => {
      const { manager } = setup()
      expect(manager.rename('nope', '결제')).toBeNull()
      expect(manager.list()).toHaveLength(0)
    })

    // The Host is holding a note that still says the title this session was spawned with, and adopt()
    // rebuilds the record from it. Without this, a renamed session comes back from a restart under
    // its old name.
    it('tells the pty the new title, so a restart does not bring the old one back', () => {
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      manager.rename(info.id, 'Auth refactor')
      expect(spawned[0].pty.remembered).toEqual([{ title: 'Auth refactor' }])
    })

    // The stored title, not the text typed: an empty name is the project folder name, and that is what
    // adopt() has to read back.
    it('remembers the normalised title rather than what was typed', () => {
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      manager.rename(info.id, '   ')
      expect(spawned[0].pty.remembered).toEqual([{ title: info.title }])
    })

    // A node-pty pty has no remember at all — nothing about it survives the app, so there is nothing
    // to remember it for. Renaming must still work exactly as it always has.
    it('renames a pty that cannot remember anything', () => {
      const pty: PtyLike = {
        pid: 1,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
        pause: () => {},
        resume: () => {}
      }
      const manager = new SessionManager(() => pty, makeDescriptors(process.platform))
      const info = manager.spawn({ account, cwd: process.cwd() })
      expect(manager.rename(info.id, 'Auth refactor')).toBe('Auth refactor')
    })
  })

  // The other half of the note's write path: something outside this manager learns a fact about a
  // session — the codex rollout watcher finding the file that session writes to — and the manager is
  // what holds the pty the note lives on.
  describe('remember', () => {
    it('passes a patch to the session pty that holds the note', () => {
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      manager.remember(info.id, { rolloutPath: 'D:/r/one.jsonl', codexSessionId: 'cx-1' })
      expect(spawned[0].pty.remembered).toEqual([{ rolloutPath: 'D:/r/one.jsonl', codexSessionId: 'cx-1' }])
    })

    // The watcher's poll can land after the tab was closed and the session forgotten; the same reason
    // rename answers null instead of throwing.
    it('ignores a session it does not have', () => {
      const { manager } = setup()
      expect(() => manager.remember('nope', { rolloutPath: 'D:/r/one.jsonl' })).not.toThrow()
    })
  })

  // Task D: whose codex holds a rollout is asked about the session's pty process. A pty the Host has not answered
  // for yet reports pid 0 (main/host/ptyFactory.ts), which is no process.
  describe('pidOf', () => {
    it("answers the session's pty process id, and null for none", () => {
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      expect(manager.pidOf(info.id)).toBe(4242)
      spawned[0].pty.pid = 0
      expect(manager.pidOf(info.id)).toBeNull()
      expect(manager.pidOf('nope')).toBeNull()
    })
  })

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

  // 대소문자를 접는 것은 win32 와 darwin 뿐 — linux 에서 대소문자만 다른 폴더는 홈 기본 폴더가 아니라 격리 계정이다
  it('기본 계정 판정은 대소문자를 접는 플랫폼에서 경로 대소문자 차이를 무시한다', () => {
    const homeDir = absPath('Users', 'tester')
    const defaultAccount: Account = { ...account, configDir: absPath('Users', 'Tester', '.CLAUDE') }
    const { manager, spawned } = setup(100, 20, homeDir)
    manager.spawn({ account: defaultAccount, cwd: process.cwd() })
    expect('CLAUDE_CONFIG_DIR' in spawned[0].opts.env).toBe(!foldsCaseHere)
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

  // 스케줄러·롤링·Slack 의 Enter 는 에이전트가 글자를 다 그리고 조용해진 뒤에 간다(sessionDriver.ts)
  it('pty 가 마지막으로 무언가 출력한 시각을 기억한다', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(5000)
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd() })
      expect(manager.lastOutput(info.id)).toBeNull()
      spawned[0].pty.dataCb('hello')
      expect(manager.lastOutput(info.id)).toBe(5000)
      vi.setSystemTime(7000)
      manager.write(info.id, 'x')
      expect(manager.lastOutput(info.id)).toBe(5000)
      spawned[0].pty.dataCb('x')
      expect(manager.lastOutput(info.id)).toBe(7000)
      expect(manager.lastOutput('nope')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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

  // win32 는 PATH 가 말하는 절대 경로로 띄운다 — 이름으로 넘기면 cmd.exe 가 작업 폴더에서 먼저 찾는다
  // (windowsExecutable.ts, 보안 검토 2026-09-28). 테스트는 npm shim 이 어디 있는지 직접 말해 준다.
  const SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const shim = (name: string): string => `${SHIM}\\${name}.cmd`
  it('buildClaudeCommand는 win32에서 cmd.exe 래퍼를 쓴다', () => {
    expect(buildClaudeCommand('win32', shim)({})).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'call', shim('claude')] })
    expect(buildClaudeCommand('darwin')({})).toEqual({ file: 'claude', args: [] })
  })

  // 모든 codex 명령의 앞머리 — 업데이트 확인을 끈다 (commands.ts 의 buildCodexCommand).
  const NO_UPDATE = ['-c', 'check_for_update_on_startup=false']

  it('buildCodexCommand는 resume·bypass를 codex 인자로 매핑한다', () => {
    expect(buildCodexCommand('win32', shim)({})).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'call', shim('codex'), ...NO_UPDATE] })
    expect(buildCodexCommand('darwin')({ resumeSessionId: 'abc' })).toEqual({
      file: 'codex', args: [...NO_UPDATE, 'resume', 'abc']
    })
    expect(buildCodexCommand('darwin')({ bypassPermissions: true })).toEqual({
      file: 'codex', args: [...NO_UPDATE, '--dangerously-bypass-approvals-and-sandbox']
    })
    // settingsFile(Claude statusLine 전용)은 무시된다
    expect(buildCodexCommand('darwin')({ settingsFile: 's.json' })).toEqual({ file: 'codex', args: NO_UPDATE })
  })

  it('buildCodexCommand는 resumePrompt를 resume 뒤 인자로 붙인다', () => {
    expect(
      buildCodexCommand('darwin')({ resumeSessionId: 'abc', resumePrompt: '이어서 작업 진행해 줘' })
    ).toEqual({ file: 'codex', args: [...NO_UPDATE, 'resume', 'abc', '이어서 작업 진행해 줘'] })
    // resume 없이 프롬프트만 오면 무시한다 (새 세션에 프롬프트를 꽂지 않는다)
    expect(buildCodexCommand('darwin')({ resumePrompt: 'x' })).toEqual({ file: 'codex', args: NO_UPDATE })
  })

  // 리뷰 지적: win32는 cmd.exe /c 래퍼라 node-pty의 MSVCRT 인용(\")이 cmd에는 통하지 않는다.
  // 따옴표가 든 프롬프트는 기동 실패(=전환 순간 탭이 죽는다), 공백 없는 &·| 는 cmd가 분리 실행한다.
  it('buildCodexCommand는 프롬프트의 셸 메타문자를 지운다 (cmd.exe 주입·인용 깨짐 방지)', () => {
    const meta = buildCodexCommand('win32', shim)({
      resumeSessionId: 'abc',
      resumePrompt: '계속"하기" & 정리 | 끝 > out < in ^esc'
    })
    expect(meta.args).toEqual(['/d', '/c', 'call', shim('codex'), ...NO_UPDATE, 'resume', 'abc', '계속 하기 정리 끝 out in esc'])
    // 공백 없이 붙은 메타문자도 분리 실행 경로가 사라진다
    expect(
      buildCodexCommand('win32', shim)({ resumeSessionId: 'abc', resumePrompt: '계속&정리' }).args.at(-1)
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
    ).toEqual([...NO_UPDATE, 'resume', 'abc', '이어서 작업 진행해 줘'])
    expect(buildCodexCommand('win32', shim)({ resumeSessionId: 'abc', resumePrompt: ' && ' }).args).toEqual([
      '/d', '/c', 'call', shim('codex'), ...NO_UPDATE, 'resume', 'abc'
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
    const ambient: Account = { ...codexAccount, configDir: absPath('Users', 'tester', '.codex') }
    const { manager, spawned } = setup(100, 20, absPath('Users', 'tester'))
    manager.spawn({ account: ambient, cwd: process.cwd() })
    expect('CODEX_HOME' in spawned[0].opts.env).toBe(false)
  })

  it('ambient codex 판정도 대소문자는 접는 플랫폼에서만 무시한다', () => {
    const ambient: Account = { ...codexAccount, configDir: absPath('Users', 'Tester', '.CODEX') }
    const { manager, spawned } = setup(100, 20, absPath('Users', 'tester'))
    manager.spawn({ account: ambient, cwd: process.cwd() })
    expect('CODEX_HOME' in spawned[0].opts.env).toBe(!foldsCaseHere)
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

  it('builds the child env from the base it was given, not from process.env', () => {
    const spawned: PtySpawnOptions[] = []
    const factory: PtyFactory = (_f, _a, opts) => { spawned.push(opts); return new FakePty() }
    const m = new SessionManager(factory, makeDescriptors(process.platform), undefined, undefined, undefined, undefined, [],
      { PATH: process.env.PATH, ONLY_IN_BASE: 'yes' })
    m.spawn({ account, cwd: process.cwd() })
    expect(spawned[0].env.ONLY_IN_BASE).toBe('yes')
    // a key only process.env has does not leak in
    process.env.ASTERA_TEST_ONLY_PROCESS = '1'
    try {
      m.spawn({ account, cwd: process.cwd() })
      expect('ASTERA_TEST_ONLY_PROCESS' in spawned[1].env).toBe(false)
    } finally { delete process.env.ASTERA_TEST_ONLY_PROCESS }
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

  // 롤링 세션에도 도구 호출 훅을 넣는다. 처음 이유였던 idle nudge(Notification 훅을 신호로 썼다)는
  // 2026-10-19 에 없어졌고, 지금 그 세션에서 이 훅을 읽는 것은 attention 과 pendingPrompt 다
  // (manager.ts 의 wantToolHooks 주석).
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
      skillsPath: 'C:/u/skills',
      profileDir: 'C:/u'
    }

    it('ASTERA_* 네 개를 주입한다 (CLI·PROFILE_DIR·SKILLS·SESSION)', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_CLI).toBe('C:/cli/astera.cmd')
      expect(spawned[0].opts.env.ASTERA_PROFILE_DIR).toBe('C:/u')
      // help가 이 디렉토리에서 orchestration-guide.md를 읽는다 (src/cli/run.ts resolveGuidePath)
      expect(spawned[0].opts.env.ASTERA_SKILLS).toBe('C:/u/skills')
      expect(spawned[0].opts.env.ASTERA_SESSION).toBeTruthy()
    })

    // **F43.** 세션의 astera 는 이제 Host 와 말하고, Host 의 주소도 못 보낸 보고를 적는 큐도 전부
    // 프로필 폴더에서 나온다. 그 폴더를 CLI 가 스스로 계산하면 개발본이 설치본으로 샌다 —
    // `-dev` 접미사는 `app.isPackaged` 에서 오고 그것을 내보내는 환경변수가 없었다. 그래서 앱이
    // 자기가 실제로 쓰고 있는 폴더를 실어 보낸다.
    it('앱이 실제로 쓰는 프로필 폴더를 실어 보낸다', () => {
      const { manager, spawned } = setup()
      manager.spawn({
        account,
        cwd: process.cwd(),
        orchEnv: { ...orchEnv, profileDir: 'C:/Users/x/AppData/Roaming/astera-dev' }
      })
      expect(spawned[0].opts.env.ASTERA_PROFILE_DIR).toBe('C:/Users/x/AppData/Roaming/astera-dev')
    })

    // Claude 세션은 SessionStart 훅으로 Astera 안내를 받고, codex 는 그 훅을 신뢰 없이 돌리지 않으므로
    // 같은 줄을 developer_instructions 로 받는다 (sessionContext.ts).
    describe('codex 의 시작 안내', () => {
      let profile: string
      beforeEach(() => {
        profile = mkdtempSync(path.join(os.tmpdir(), 'astera-mgr-brief-'))
        writeFileSync(path.join(profile, 'app-settings.json'), JSON.stringify({ agentAppEnabled: true }))
      })
      afterEach(() => rmSync(profile, { recursive: true, force: true }))

      it('Astera 가 띄운 codex 세션은 그 프로필 설정대로 안내를 받는다', () => {
        const { manager, spawned } = setup()
        manager.spawn({ account: codexAccount, cwd: process.cwd(), orchEnv: { ...orchEnv, profileDir: profile } })
        const text = argsText(spawned[0].args)
        expect(text).toContain('developer_instructions=This session runs inside Astera.')
        expect(text).toContain('astera app js')
      })
      it('Claude 세션과 orchEnv 없는 codex 세션에는 싣지 않는다', () => {
        const { manager, spawned } = setup()
        manager.spawn({ account, cwd: process.cwd(), orchEnv: { ...orchEnv, profileDir: profile } })
        manager.spawn({ account: codexAccount, cwd: process.cwd() })
        expect(argsText(spawned[0].args)).not.toContain('developer_instructions')
        expect(argsText(spawned[1].args)).not.toContain('developer_instructions')
      })
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
      // 남의 인스턴스의 프로필이 새면 이 세션의 워커가 남의 Host 에 보고하고 남의 큐에 적는다 —
      // 없어진 ASTERA_INFO 가 하던 누수를 그대로 물려받는 변수다.
      ASTERA_PROFILE_DIR: 'C:/other-instance',
      ASTERA_SKILLS: 'C:/other-instance/skills',
      ASTERA_SESSION: 'inherited-session-id'
    }
    const stubInherited = (): void => {
      for (const [k, v] of Object.entries(INHERITED)) vi.stubEnv(k, v)
    }
    afterEach(() => vi.unstubAllEnvs())

    it('orchEnv가 없으면 상속된 ASTERA_*까지 지운다', () => {
      // 앱을 Astera 세션의 셸에서 띄우면(`npm run dev`가 그 경로다) 앱 프로세스가 **다른
      // 인스턴스의** ASTERA_CLI·PROFILE_DIR 을 물고 시작한다. 그것이 그대로 새 세션에 상속되면
      // orchestration을 끈 세션의 에이전트가 남의 인스턴스의 Host 와 큐를 쥐게 되고,
      // 상속된 ASTERA_SESSION은 남의 세션 신원으로 보고하게 만든다.
      // 넣지 않는 것으로는 부족하고 지워야 한다 — configDirEnv와 main/core.ts의 규약이 같다.
      stubInherited()
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      for (const k of Object.keys(INHERITED)) {
        expect(k in spawned[0].opts.env).toBe(false)
      }
    })

    // The same leak one variable family over, and with a worse symptom. Launch the app from a terminal
    // inside a Claude Code session and every session it spawns is told it is a child of that one, at
    // which point Claude Code writes no transcript at all — and the conversation view, which reads a
    // Claude session through exactly that file, is empty forever for a session that is answering fine.
    it('clears the marks a Claude Code session leaves on its own environment', () => {
      vi.stubEnv('CLAUDECODE', '1')
      vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'parent-session')
      vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli')
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'])
        expect(k in spawned[0].opts.env).toBe(false)
    })

    // What a person set for themselves is not a mark of the parent's session, and stays.
    it('leaves a setting the person chose alone', () => {
      vi.stubEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '64000')
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      expect(spawned[0].opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000')
    })

    it('orchEnv가 있으면 상속값이 아니라 orchEnv 값이 이긴다', () => {
      stubInherited()
      const { manager, spawned } = setup()
      const info = manager.spawn({ account, cwd: process.cwd(), orchEnv })
      expect(spawned[0].opts.env.ASTERA_CLI).toBe('C:/cli/astera.cmd')
      expect(spawned[0].opts.env.ASTERA_PROFILE_DIR).toBe('C:/u')
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

  // The Host stores this and hands it back after a restart; it is the only thing that lets the app
  // rebuild this session's record without having persisted anything itself.
  it('tells the pty factory what this session is, so it can be rebuilt later', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({
      account,
      cwd: process.cwd(),
      title: 'Auth refactor',
      rollAccountIds: ['acc_1', 'acc_2']
    })
    expect(spawned[0].opts.meta).toEqual({
      kind: 'session',
      id: info.id,
      restore: {
        accountId: account.id,
        cwd: process.cwd(),
        title: 'Auth refactor',
        rollAccountIds: ['acc_1', 'acc_2']
      }
    })
  })

  // A rolling respawn is born with where it came from and its chain's snapshot (S6 R6). The manager's
  // own keys are written after, so nothing a caller slips in can rename the account the pty runs on.
  it('merges restoreExtra into the note after its own keys (S6 R6)', () => {
    const { manager, spawned } = setup()
    const roll: RollSnapshot = {
      v: 1, provider: 'claude', accountIds: ['a'], currentIndex: 0, streak: 0, recovery: [null], blocks: {},
      wait: null, inPlaceUsed: false, rolledAt: null, awaitingPrompt: true,
      claude: { sessionId: null, transcriptPath: null, tailOffset: null, tailSince: null }, writtenAt: 0
    }
    manager.spawn({
      account,
      cwd: process.cwd(),
      rollAccountIds: ['a'],
      // The type refuses a manager key here; the cast is how this test forges one anyway, to pin the
      // runtime precedence that still stands behind the type.
      restoreExtra: { rolledFrom: 's0', roll, accountId: 'forged' } as RollSpawnExtra
    })
    const restore = spawned[0].opts.meta?.restore as Record<string, unknown>
    expect(restore).toMatchObject({ rolledFrom: 's0', roll: { v: 1, provider: 'claude' } })
    expect(restore.accountId).toBe(account.id) // the manager's own keys win
  })

  // An agent-started session's tab closes when it ends (2026-10-20): the mark is in its info and its note, and a
  // session a person started carries neither
  it('writes startedBy agent into the info and the note, and nothing for a person’s session', () => {
    const { manager, spawned } = setup()
    const agent = manager.spawn({ account, cwd: process.cwd(), startedBy: 'agent' })
    expect(agent.startedBy).toBe('agent')
    expect(spawned[0].opts.meta?.restore).toMatchObject({ startedBy: 'agent' })
    const person = manager.spawn({ account, cwd: process.cwd() })
    expect(person).not.toHaveProperty('startedBy')
    expect(spawned[1].opts.meta?.restore).not.toHaveProperty('startedBy')
  })

  // Agent Profiles (design §5, ledger Ruling P2): the profile a session was started from rides its info and its note
  // the way startedBy does, and its capabilities are the ones resolved for that account and profile
  it('writes agentProfileId into the info and the note, reads it back from the note, and nothing without one', () => {
    const { manager, spawned } = setup()
    const withProfile = manager.spawn({ account, cwd: process.cwd(), agentProfileId: 'ap_000000000001' })
    expect(withProfile.agentProfileId).toBe('ap_000000000001')
    const note = spawned[0].opts.meta!
    expect(note.restore).toMatchObject({ agentProfileId: 'ap_000000000001' })
    expect(sessionInfoFromNote(note)?.agentProfileId).toBe('ap_000000000001')
    const without = manager.spawn({ account, cwd: process.cwd() })
    expect(without).not.toHaveProperty('agentProfileId')
    expect(spawned[1].opts.meta?.restore).not.toHaveProperty('agentProfileId')
    expect(sessionInfoFromNote(spawned[1].opts.meta!)).not.toHaveProperty('agentProfileId')
  })

  it('prepares and spawns with the capabilities of the session’s account and profile', async () => {
    const caps = (given: string[]): SessionCapabilities => ({
      context: { kind: 'implicit', accounts: [account.id], policyMode: 'compatibility', executionMode: 'managed' },
      args: [], env: { GIVEN: given.join(',') }, given, gatewayGrant: [], skipped: []
    })
    const refreshed: [string, string | undefined][] = []
    const spawned: PtySpawnOptions[] = []
    const checks: SpawnChecks = {
      linkLook: null,
      cwd: async () => 'present', gitBash: createGitBashResolver(async () => 'absent'), platform: 'linux', now: Date.now, syncExists: () => true, log: () => {}
    }
    const manager = new SessionManager((_f, _a, o) => (spawned.push(o), new FakePty()), makeDescriptors('linux'), 100, 20, '/home/t', undefined, [], {}, checks)
    manager.capabilities = {
      get: (a, p) => (p === 'ap_000000000001' ? caps(['docs']) : caps(['docs', 'linear'])),
      refresh: async (a, p) => void refreshed.push([a.id, p])
    }
    await manager.prepare({ account, cwd: '/work', agentProfileId: 'ap_000000000001' })
    manager.spawn({ account, cwd: '/work', agentProfileId: 'ap_000000000001' })
    await manager.prepare({ account, cwd: '/work' })
    manager.spawn({ account, cwd: '/work' })
    expect(refreshed).toEqual([[account.id, 'ap_000000000001'], [account.id, undefined]])
    expect(spawned[0].env.GIVEN).toBe('docs')
    expect(spawned[1].env.GIVEN).toBe('docs,linear')
  })

  describe('adopt', () => {
    // After a restart the process is already running; adopt rebuilds only the app's own record of it.
    it('adopts a running pty and puts the session back in the list', () => {
      const { manager } = setup()
      const pty = new FakePty()
      const info = manager.adopt({
        kind: 'session',
        id: 'sess-from-host',
        pty,
        restore: { accountId: account.id, cwd: 'D:/p', title: 'Auth refactor', rollAccountIds: ['acc_1'] }
      })
      expect(info).toMatchObject({
        accountId: account.id,
        cwd: 'D:/p',
        title: 'Auth refactor',
        status: 'running',
        rollAccountIds: ['acc_1']
      })
      expect(manager.list().map((s) => s.id)).toEqual([info!.id])
    })

    it('an adopted session streams and exits like a spawned one', () => {
      const { manager } = setup()
      const data: string[] = []
      let exited: number | null = null
      manager.onData = (e) => data.push(e.data)
      manager.onExit = (e) => {
        exited = e.exitCode
      }
      const pty = new FakePty()
      const info = manager.adopt({ kind: 'session', id: 'sess-from-host', pty, restore: { accountId: account.id, cwd: 'D:/p', title: 't' } })!
      pty.dataCb('output')
      pty.exitCb({ exitCode: 0 })
      expect(data).toEqual(['output'])
      expect(exited).toBe(0)
      expect(manager.list().find((s) => s.id === info.id)?.status).toBe('exited')
    })

    // The backpressure accounting is part of the record, not of the spawn — an adopted session with no
    // tab is exactly the one that would otherwise wedge at highWater.
    it('an adopted session pauses at highWater and resumes on an ack, like a spawned one', () => {
      const { manager } = setup(100, 20)
      const pty = new FakePty()
      const info = manager.adopt({ kind: 'session', id: 'sess-from-host', pty, restore: { accountId: account.id, cwd: 'D:/p', title: 't' } })!
      pty.dataCb('x'.repeat(150))
      expect(pty.paused).toBe(true)
      manager.ack(info.id, 150)
      expect(pty.paused).toBe(false)
    })

    // The directory may have been renamed or unmounted since; the process is already running there, so
    // refusing would orphan it. Only spawn checks the cwd, because only spawn is about to use it.
    it('does not check the cwd — the process is already running in it', () => {
      const { manager } = setup()
      const missing = path.join(process.cwd(), 'no-such-directory-for-adopt')
      expect(existsSync(missing)).toBe(false)
      const adopted = manager.adopt({
        kind: 'session',
        id: 'sess-from-host',
        pty: new FakePty(),
        restore: { accountId: account.id, cwd: missing, title: 't' }
      })
      expect(adopted).not.toBeNull()
    })

    // The session keeps the id it had before the restart. The agent process is still writing its
    // statusLine and hook capture into files named after that id, and the scheduler's entries key on it
    // too — under an id of our own invention the app would read files nothing ever wrote.
    it('keeps the id it is handed rather than minting one', () => {
      const { manager } = setup()
      const info = manager.adopt({
        kind: 'session',
        id: 'sess-from-host',
        pty: new FakePty(),
        restore: { accountId: account.id, cwd: 'D:/p', title: 't' }
      })!
      expect(info.id).toBe('sess-from-host')
      expect(manager.list().map((s) => s.id)).toEqual(['sess-from-host'])
      // and it is the id the manager answers to from here on
      expect(manager.rename('sess-from-host', 'renamed')).toBe('renamed')
    })

    // The app may have died inside a backpressure pause — a window every tabless orchestration worker
    // sits in constantly, because nothing acks its output. Nothing releases that pause while the app is
    // gone, and a rebuilt record says paused:false, so ack() (which resumes only what it believes is
    // paused) could never release it either: the session would be wedged shut while reporting 'running'.
    it('resumes the pty it adopts, in case the app died inside a backpressure pause', () => {
      const { manager } = setup()
      const pty = new FakePty()
      manager.adopt({
        kind: 'session',
        id: 'sess-from-host',
        pty,
        restore: { accountId: account.id, cwd: 'D:/p', title: 't' }
      })
      expect(pty.resumeCalls).toBe(1)
    })

    // null is "I cannot read this", and the shapes overlap enough that a note of another kind can be
    // readable — so the kind is checked before anything else, not inferred from the fields present.
    it('refuses a note of another kind', () => {
      const { manager } = setup()
      const asRun = manager.adopt({
        kind: 'run',
        id: 'run-from-host',
        pty: new FakePty(),
        restore: { accountId: account.id, cwd: 'D:/p', title: 't' }
      })
      expect(asRun).toBeNull()
      expect(manager.list()).toEqual([])
    })

    // The note crossed a process boundary, so its contents are parsed rather than trusted.
    it('drops a rollAccountIds that is not all strings', () => {
      const { manager } = setup()
      const info = manager.adopt({
        kind: 'session',
        id: 'sess-from-host',
        pty: new FakePty(),
        restore: { accountId: account.id, cwd: 'D:/p', title: 't', rollAccountIds: ['acc_1', 7] }
      })!
      expect(info).not.toHaveProperty('rollAccountIds')
    })

    it('refuses a restore it cannot read rather than inventing a session', () => {
      const { manager } = setup()
      expect(manager.adopt({ kind: 'session', id: 'sess-from-host', pty: new FakePty(), restore: { cwd: 'D:/p' } })).toBeNull()
      expect(manager.list()).toEqual([])
    })

    // A dropped connection ends every handle with PTY_LOST_SIGHT_EXIT_CODE, so the manager marks the
    // session exited while the Host keeps running the real process. When the socket comes back the same
    // session is adopted again, under the id it never stopped having — so the record this manager holds
    // has to be the new one, once, rather than a second entry beside the corpse.
    it('takes a session back over its own exited record, leaving one live record under the same id', () => {
      const { manager } = setup()
      const data: string[] = []
      manager.onData = (e) => data.push(e.data)
      const dropped = new FakePty()
      manager.adopt({ kind: 'session', id: 'sess-from-host', pty: dropped, restore: { accountId: account.id, cwd: 'D:/p', title: 't' } })
      dropped.exitCb({ exitCode: PTY_LOST_SIGHT_EXIT_CODE })
      expect(manager.list().find((s) => s.id === 'sess-from-host')?.status).toBe('exited')

      const back = new FakePty()
      const info = manager.adopt({ kind: 'session', id: 'sess-from-host', pty: back, restore: { accountId: account.id, cwd: 'D:/p', title: 't' } })!
      expect(info.id).toBe('sess-from-host')
      expect(manager.list().filter((s) => s.id === 'sess-from-host')).toHaveLength(1)
      expect(manager.list().find((s) => s.id === 'sess-from-host')?.status).toBe('running')
      // The live record is the new pty's, not the dead one's: input goes to the pty that can take it,
      // and the old handle is no longer the one the manager answers for.
      manager.write('sess-from-host', 'hello')
      expect(back.written).toEqual(['hello'])
      expect(dropped.written).toEqual([])
      // What a person typed in the tab is marked so all the way to the pty (final review I4).
      manager.write('sess-from-host', 'typed', { typed: true })
      expect(back.typed).toEqual([false, true])
      back.dataCb('from the reattach')
      expect(data).toEqual(['from the reattach'])
    })
  })

  // Quitting used to be one decision for every pty at once, and the Host's startup is a window in
  // which the app makes some of its own before the Host answers. Splitting the running sessions by
  // who owns their pty is what lets the quit path end the app's own children — which die with the
  // app anyway — while leaving the Host's alone.
  it('forgets an exited session and keeps a running one', () => {
    const ptys: FakePty[] = []
    const m = new SessionManager((_f, _a, _o) => { const p = new FakePty(); ptys.push(p); return p }, makeDescriptors(process.platform))
    const a = m.spawn({ account, cwd: process.cwd() }); const b = m.spawn({ account, cwd: process.cwd() })
    ptys[0].emitExit(0)
    expect(m.forget(a.id)).toBe(true)
    expect(m.forget(b.id)).toBe(false)
    expect(m.list().map((s) => s.id)).toEqual([b.id])
  })

  describe('who a running session belongs to', () => {
    it('splits the running sessions into the ones the app owns and the ones that outlive it', () => {
      const { manager, spawned } = setup()
      const mine = manager.spawn({ account, cwd: process.cwd() })
      const hosts = manager.spawn({ account, cwd: process.cwd() })
      spawned[1].pty.outlivesApp = true
      expect(manager.runningAppOwned().map((s) => s.id)).toEqual([mine.id])
      expect(manager.runningOutlivingApp().map((s) => s.id)).toEqual([hosts.id])
    })

    // list() keeps exited sessions so a tab can outlive its process. Neither list may report one:
    // the quit path would kill a pty that is already gone, and the close confirmation would promise
    // the person a session that is not running comes back.
    it('counts neither an exited session, whoever owned it', () => {
      const { manager, spawned } = setup()
      manager.spawn({ account, cwd: process.cwd() })
      manager.spawn({ account, cwd: process.cwd() })
      spawned[1].pty.outlivesApp = true
      spawned[0].pty.exitCb({ exitCode: 0 })
      spawned[1].pty.exitCb({ exitCode: 0 })
      expect(manager.runningAppOwned()).toEqual([])
      expect(manager.runningOutlivingApp()).toEqual([])
    })
  })
})

describe('SessionManager.prepare — the spawn path never waits on a sync probe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function withChecks(checks: Partial<SpawnChecks>) {
    const spawned: { file: string; opts: PtySpawnOptions }[] = []
    const factory: PtyFactory = (file, _args, opts) => {
      spawned.push({ file, opts })
      return new FakePty()
    }
    // Every sync look at the disk goes through this one function, so counting it proves none ran.
    const syncExists = vi.fn(() => true)
    const log = vi.fn()
    const full: SpawnChecks = {
      linkLook: null,
      cwd: async () => 'present',
      gitBash: createGitBashResolver(async () => 'absent'),
      platform: process.platform,
      now: Date.now,
      syncExists,
      log,
      ...checks
    }
    const manager = new SessionManager(factory, makeDescriptors('win32'), 100, 20, 'C:\\Users\\tester', undefined, [], { PATH: 'C:\\a' }, full)
    return { manager, spawned, syncExists: full.syncExists as typeof syncExists, log: full.log as typeof log }
  }

  it('a folder whose probe never answers fails at 1.5 s with "folder not reachable", and nothing is spawned', async () => {
    vi.useFakeTimers()
    const cwd = '\\\\offline-server\\share\\proj'
    const { manager, spawned } = withChecks({
      cwd: createProber({ access: () => new Promise<void>(() => {}), log: () => {}, pool: createProbePool(), skipQueue: true })
    })
    const outcome = manager.prepare({ account, cwd }).then(
      () => 'resolved',
      (e: Error) => e.message
    )
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    let settled = false
    void outcome.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe(`CWD_UNREACHABLE: folder not reachable: ${cwd}`)
    expect(spawned).toHaveLength(0)
  })

  it('a local folder is confirmed while four PATH probes hang on an offline drive', async () => {
    vi.useFakeTimers()
    const pool = createProbePool(PROBE_CONCURRENCY)
    const access = (p: string) => (p.startsWith('Z:') ? new Promise<void>(() => {}) : Promise.resolve())
    const pathProbe = createProber({ access, pool, log: () => {} })
    const cwdProbe = createProber({ access, pool, log: () => {}, skipQueue: true })
    const hung = ['Z:\\a\\pwsh.exe', 'Z:\\b\\pwsh.exe', 'Z:\\a\\powershell.exe', 'Z:\\b\\powershell.exe', 'Z:\\c\\cmd.exe'].map((p) =>
      pathProbe(p)
    )
    const { manager } = withChecks({ cwd: cwdProbe, platform: 'linux' })
    // No time passes: the folder's answer does not wait for a slot.
    await expect(manager.prepare({ account, cwd: 'C:\\work\\proj' })).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(hung)
  })

  // Second pass M2-1, M2-2: the provider's own lookups (its CLI on PATH, codex's --no-daemon) run in prepare, off the
  // thread, so the spawn after it finds their answers.
  it("prepare runs the provider's own prepare", async () => {
    let prepared = 0
    const d = makeDescriptors('win32')
    const descriptors = { ...d, claude: { ...d.claude, prepare: async () => void prepared++ }, codex: { ...d.codex, prepare: async () => void prepared++ } }
    const full: SpawnChecks = {
      linkLook: null,
      cwd: async () => 'present',
      gitBash: createGitBashResolver(async () => 'absent'),
      platform: 'linux',
      now: Date.now,
      syncExists: () => true,
      log: () => {}
    }
    const manager = new SessionManager(() => new FakePty(), descriptors, 100, 20, 'C:\\Users\\tester', undefined, [], { PATH: 'C:\\a' }, full)
    await manager.prepare({ account, cwd: 'C:\\work\\proj' })
    expect(prepared).toBe(1)
  })

  it('a folder that is not there is still CWD_MISSING, in the wording the caller asks for', async () => {
    const { manager } = withChecks({ cwd: async () => 'absent' })
    await expect(manager.prepare({ account, cwd: 'Z:\\gone' })).rejects.toThrow('CWD_MISSING: Z:\\gone')
    await expect(manager.prepare({ account, cwd: 'Z:\\gone', missing: 'CWD_MISSING: Z:\\gone does not exist' })).rejects.toThrow(
      'CWD_MISSING: Z:\\gone does not exist'
    )
  })

  it('after prepare, spawn trusts the checked folder and the Git Bash it found — nothing sync runs, nothing is warned', async () => {
    let resolves = 0
    const gitBash = createGitBashResolver(async (p) => {
      resolves++
      return p === 'C:\\Program Files\\Git\\bin\\bash.exe' ? 'present' : 'absent'
    })
    const cwd = 'Z:\\prepared\\but\\not\\on\\this\\disk'
    const { manager, spawned, syncExists, log } = withChecks({ gitBash, platform: 'win32' })
    await manager.prepare({ account, cwd })
    const before = resolves
    manager.spawn({ account, cwd })
    expect(spawned[0].opts.cwd).toBe(cwd)
    expect(spawned[0].opts.env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(resolves).toBe(before)
    expect(syncExists).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('the Git Bash cache expiring between prepare and spawn does not send spawn back to the sync search', async () => {
    let t = 0
    const gitBash = createGitBashResolver(
      async (p) => (p === 'C:\\Program Files\\Git\\bin\\bash.exe' ? 'present' : 'absent'),
      new PathKeyedCache(PROBE_CACHE_TTL_MS, () => t)
    )
    const { manager, spawned, syncExists, log } = withChecks({ gitBash, platform: 'win32', now: () => t })
    // The cache entry was made just before the 5-minute mark; prepare reads it at 4:59.999...
    await gitBash.resolve({ PATH: 'C:\\a' })
    t = PROBE_CACHE_TTL_MS - 1
    await manager.prepare({ account, cwd: 'C:\\w' })
    // ...and by the spawn it has expired.
    t = PROBE_CACHE_TTL_MS + 1
    expect(gitBash.peek({ PATH: 'C:\\a' })).toBeUndefined()
    manager.spawn({ account, cwd: 'C:\\w' })
    expect(spawned[0].opts.env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(syncExists).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  // Without Git Bash the session's statusLine capture never runs for its whole life, so the app never
  // learns its usage. When a timeout is why, the owner's log (sessions.log, host.log) must say so,
  // once per such spawn.
  it('a spawn that gets no Git Bash because the lookup timed out says so once in the log', async () => {
    const gitBash = createGitBashResolver(async (p) => (p.startsWith('C:\\Program Files') ? 'timeout' : 'absent'))
    const { manager, spawned, log } = withChecks({ gitBash, platform: 'win32' })
    await manager.prepare({ account, cwd: 'C:\\w' })
    manager.spawn({ account, cwd: 'C:\\w' })
    expect(spawned[0].opts.env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined()
    const lines = log.mock.calls.map((c) => String(c[0])).filter((m) => /Git Bash/.test(m))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/timed out/)
  })

  it('a spawn with no Git Bash on a clean lookup (nothing timed out) logs nothing', async () => {
    const { manager, log } = withChecks({ gitBash: createGitBashResolver(async () => 'absent'), platform: 'win32' })
    await manager.prepare({ account, cwd: 'C:\\w' })
    manager.spawn({ account, cwd: 'C:\\w' })
    expect(log).not.toHaveBeenCalled()
  })

  it('a spawn nobody prepared falls back to the sync checks and says so in the log', () => {
    const { manager, syncExists, log } = withChecks({ platform: 'win32' })
    manager.spawn({ account, cwd: 'C:\\unprepared' })
    expect(syncExists).toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/without prepare/)
  })

  it('a second prepare of the same folder reuses the first check, and does not probe for Git Bash again', async () => {
    let resolves = 0
    let cwdProbes = 0
    const gitBash = createGitBashResolver(async () => {
      resolves++
      return 'absent'
    })
    const { manager } = withChecks({
      gitBash,
      platform: 'win32',
      cwd: async () => {
        cwdProbes++
        return 'present'
      }
    })
    await manager.prepare({ account, cwd: 'C:\\one' })
    const first = resolves
    await manager.prepare({ account, cwd: 'C:\\one' })
    await manager.prepare({ account, cwd: 'C:\\two' })
    expect(resolves).toBe(first)
    expect(cwdProbes).toBe(2)
  })

  it('a folder checked long ago is not trusted without a new check', async () => {
    let t = 0
    const { manager, syncExists } = withChecks({ now: () => t })
    syncExists.mockReturnValue(false)
    const cwd = 'Z:\\prepared\\but\\not\\on\\this\\disk'
    await manager.prepare({ account, cwd })
    t += 10 * 60_000
    expect(() => manager.spawn({ account, cwd })).toThrow(/CWD_MISSING/)
  })
})

// Agent Control Plane release 1 (design §4.5, AC-09.1): the spawn reads the shared capabilities a prepare just
// refreshed for that account; with none set, argv and env are exactly as before.
describe('shared capabilities', () => {
  const caps = {
    context: { kind: 'implicit' as const, accounts: ['acc-1'], policyMode: 'compatibility' as const, executionMode: 'managed' as const },
    args: ['--mcp-config', '/p/claude-1.json'],
    env: { LINEAR_API_KEY: 'secret-in-env' },
    given: ['linear'],
    gatewayGrant: ['mcp-linear'],
    skipped: []
  }
  it('prepare refreshes the account, and spawn adds its arguments and environment', async () => {
    const { manager, spawned } = setup()
    const refreshed: string[] = []
    manager.capabilities = { get: (a) => (a.id === 'acc-1' ? caps : null), refresh: async (a) => void refreshed.push(a.id) }
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'astera-caps-'))
    try {
      await manager.prepare({ account, cwd })
      manager.spawn({ account, cwd })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
    expect(refreshed).toEqual(['acc-1'])
    expect(argsText(spawned[0].args)).toContain('--mcp-config /p/claude-1.json')
    expect(spawned[0].opts.env?.LINEAR_API_KEY).toBe('secret-in-env')
  })
  // Release 2 (Gateway design §4.2): every spawn carries a Gateway token of its own and the servers it was given
  it('gives each spawn its own Gateway token and the grant', () => {
    const { manager, spawned } = setup()
    manager.capabilities = { get: () => caps, refresh: async () => {} }
    manager.spawn({ account, cwd: os.tmpdir() })
    manager.spawn({ account, cwd: os.tmpdir() })
    const [a, b] = spawned.map((s) => s.opts.env ?? {})
    expect(a.ASTERA_GATEWAY_GRANT).toBe('mcp-linear')
    expect(a.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b.ASTERA_GATEWAY_TOKEN).not.toBe(a.ASTERA_GATEWAY_TOKEN)
  })
  it('without capabilities the command and environment are unchanged', () => {
    const a = setup()
    const b = setup()
    b.manager.capabilities = { get: () => null, refresh: async () => {} }
    a.manager.spawn({ account, cwd: os.tmpdir() })
    b.manager.spawn({ account, cwd: os.tmpdir() })
    expect(b.spawned[0].args).toEqual(a.spawned[0].args)
    // Each spawn's workload token is its own; nothing else differs.
    const bare = (env: Record<string, string | undefined> | undefined) => ({ ...env, ASTERA_GATEWAY_TOKEN: undefined })
    expect(bare(b.spawned[0].opts.env)).toEqual(bare(a.spawned[0].opts.env))
  })
  it('gives a spawn with no capabilities a workload token and an empty grant', () => {
    const { manager, spawned } = setup()
    manager.spawn({ account, cwd: os.tmpdir() })
    const env = spawned[0].opts.env ?? {}
    expect(env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(env.ASTERA_GATEWAY_GRANT).toBe('')
  })
})

// Observe mode (observe mode design §4, §5, Review Focus 1): the mode a prepare read is the session's for life. Observed,
// a Claude session is pointed at the hook settings that add the PostToolUse capture, and the note says the session was
// started observed, which is what the Host's recorder asks before it keeps a call. In compatibility nothing changes.
describe('observe mode at spawn', () => {
  const capsIn = (policyMode: 'compatibility' | 'observe' | 'enforce'): SessionCapabilities => ({
    context: { kind: 'implicit', accounts: [account.id], policyMode, executionMode: 'managed' },
    args: [], env: {}, given: [], gatewayGrant: [], skipped: []
  })
  const rig = (policyMode: 'compatibility' | 'observe' | 'enforce' | null, filesWritten = true) => {
    const spawned: PtySpawnOptions[] = []
    const argv: Array<string[] | string> = []
    const asked: unknown[] = []
    const checks: SpawnChecks = {
      linkLook: null,
      cwd: async () => 'present', gitBash: createGitBashResolver(async () => 'absent'), platform: 'linux', now: Date.now, syncExists: () => true, log: () => {}
    }
    const manager = new SessionManager((_f, a, o) => (argv.push(a), spawned.push(o), new FakePty()), makeDescriptors('linux'), 100, 20, '/home/t', (id, _acc, o) => {
      asked.push(o)
      const observed = o?.observe === true && filesWritten
      const enforced = observed && o?.enforce === true
      return {
        settingsFile: enforced ? 'enforce.json' : observed ? 'observe.json' : 's.json', outPath: 'o.json', originalCommand: null, hookOutPath: `/h/${id}.jsonl`,
        ...(observed ? { observed: true } : {}),
        ...(enforced ? { enforced: true } : {})
      }
    }, [], {}, checks)
    if (policyMode !== null) manager.capabilities = { get: () => capsIn(policyMode), refresh: async () => {} }
    const observeHooks = vi.fn(async () => {})
    manager.observeHooks = observeHooks
    const enforceHooks = vi.fn(async () => (filesWritten ? ('ok' as const) : ('no-interpreter' as const)))
    manager.enforceHooks = enforceHooks
    manager.enforce = { args: (provider) => (filesWritten && provider === 'codex' ? ['-c', 'hooks.PreToolUse=[x]', '-c', 'hooks.state={y}'] : null) }
    return { manager, spawned, argv, asked, observeHooks, enforceHooks }
  }

  it('an Enforce start on an older CLI is refused with the reason before anything spawns', async () => {
    for (const acc of [account, codexAccount]) {
      const e = rig('enforce')
      const warmed: string[] = []
      e.manager.enforce = {
        args: () => ['-c', 'x'],
        warm: async (p) => void warmed.push(p),
        blocker: (p) => `ENFORCE_UNAVAILABLE: cli-too-old ${p} 0.1.0 9.9.9`
      }
      const p = acc.provider ?? 'claude'
      await expect(e.manager.prepare({ account: acc, cwd: '/work' })).rejects.toThrow(`ENFORCE_UNAVAILABLE: cli-too-old ${p} 0.1.0 9.9.9`)
      expect(warmed).toEqual([p])
      // Asked before the hook is written, and a spawn nobody prepared is refused the same way
      expect(e.enforceHooks).not.toHaveBeenCalled()
      expect(() => e.manager.spawn({ account: acc, cwd: '/work' })).toThrow(`ENFORCE_UNAVAILABLE: cli-too-old ${p} 0.1.0 9.9.9`)
      expect(e.spawned).toHaveLength(0)
    }
    // Observe asks no version
    const o = rig('observe')
    const blocker = vi.fn(() => 'ENFORCE_UNAVAILABLE: cli-version-unknown claude')
    o.manager.enforce = { args: () => null, blocker }
    await o.manager.prepare({ account, cwd: '/work' })
    o.manager.spawn({ account, cwd: '/work' })
    expect(blocker).not.toHaveBeenCalled()
    expect(o.spawned).toHaveLength(1)
  })

  it('a Codex session started in enforce carries the hook args, an observe one does not', async () => {
    const e = rig('enforce')
    await e.manager.prepare({ account: codexAccount, cwd: '/work' })
    expect(e.enforceHooks).toHaveBeenCalledTimes(1)
    e.manager.spawn({ account: codexAccount, cwd: '/work', initialPrompt: 'go' })
    const a = e.argv[0] as string[]
    // Root options, ahead of the prompt, so they reach `resume` too
    expect(a.slice(a.indexOf('hooks.PreToolUse=[x]') - 1, a.indexOf('hooks.PreToolUse=[x]') + 3)).toEqual(['-c', 'hooks.PreToolUse=[x]', '-c', 'hooks.state={y}'])
    expect(a.indexOf('hooks.PreToolUse=[x]')).toBeLessThan(a.indexOf('go'))
    expect(e.spawned[0].meta?.restore).toMatchObject({ observed: true, enforced: true })
    const o = rig('observe')
    await o.manager.prepare({ account: codexAccount, cwd: '/work' })
    o.manager.spawn({ account: codexAccount, cwd: '/work' })
    expect(o.argv[0]).not.toContain('hooks.PreToolUse=[x]')
    expect(o.spawned[0].meta?.restore).not.toHaveProperty('enforced')
    // No hook: refused at the prepare, and at the spawn
    const n = rig('enforce', false)
    await expect(n.manager.prepare({ account: codexAccount, cwd: '/work' })).rejects.toThrow(/^ENFORCE_UNAVAILABLE: no-interpreter/)
    expect(() => n.manager.spawn({ account: codexAccount, cwd: '/work' })).toThrow(/^ENFORCE_UNAVAILABLE: no-interpreter/)
    expect(n.spawned).toHaveLength(0)
  })

  // Enforce (enforce design §5, E5): the blocking hook's settings, the note's mark, and no start without them
  it('an enforce session is pointed at the enforce settings and marked enforced, an observe one is not', async () => {
    const e = rig('enforce')
    await e.manager.prepare({ account, cwd: '/work' })
    expect(e.enforceHooks).toHaveBeenCalledTimes(1)
    e.manager.spawn({ account, cwd: '/work' })
    expect(e.asked[0]).toStrictEqual({ toolHooks: false, observe: true, enforce: true })
    expect(argsText(e.argv[0])).toContain('enforce.json')
    expect(e.spawned[0].meta?.restore).toMatchObject({ observed: true, enforced: true })
    const o = rig('observe')
    await o.manager.prepare({ account, cwd: '/work' })
    expect(o.enforceHooks).not.toHaveBeenCalled()
    o.manager.spawn({ account, cwd: '/work' })
    expect(o.spawned[0].meta?.restore).not.toHaveProperty('enforced')
  })

  // Final review I5b: the hook names its file by ASTERA_SESSION, which a session without orchestration did not get
  it('an enforce session gets its id whether or not orchestration is up', async () => {
    const e = rig('enforce')
    await e.manager.prepare({ account, cwd: '/work' })
    e.manager.spawn({ account, cwd: '/work' })
    const id = e.spawned[0].meta?.id
    expect(e.spawned[0].env?.ASTERA_SESSION).toBe(id)
    const o = rig('observe')
    await o.manager.prepare({ account, cwd: '/work' })
    o.manager.spawn({ account, cwd: '/work' })
    expect(o.spawned[0].env?.ASTERA_SESSION).toBeUndefined()
  })

  it('says why the hook is not in place: no interpreter, or files it could not write', async () => {
    const e = rig('enforce')
    e.manager.enforceHooks = async () => 'hook-write-failed'
    await expect(e.manager.prepare({ account, cwd: '/work' })).rejects.toThrow(/^ENFORCE_UNAVAILABLE: hook-write-failed/)
  })

  it('asks the version check which kind of session it is', async () => {
    const e = rig('enforce')
    const asked: unknown[] = []
    e.manager.enforce = { args: () => ['-c', 'x'], blocker: (p, kind) => (asked.push([p, kind]), null) }
    await e.manager.prepare({ account: codexAccount, cwd: '/work' })
    e.manager.spawn({ account: codexAccount, cwd: '/work' })
    expect(asked).toEqual([
      ['codex', 'terminal'],
      ['codex', 'terminal']
    ])
  })

  it('an enforce start whose blocking hook cannot be written is refused before anything spawns', async () => {
    const { manager, spawned } = rig('enforce', false)
    await expect(manager.prepare({ account, cwd: '/work' })).rejects.toThrow(/^ENFORCE_UNAVAILABLE: no-interpreter/)
    expect(() => manager.spawn({ account, cwd: '/work' })).toThrow(/^ENFORCE_UNAVAILABLE: no-interpreter/)
    expect(spawned).toHaveLength(0)
  })

  it('in compatibility the hook settings are asked for as before and the note carries no mark', async () => {
    for (const mode of ['compatibility', null] as const) {
      const { manager, spawned, asked, observeHooks } = rig(mode)
      await manager.prepare({ account, cwd: '/work' })
      manager.spawn({ account, cwd: '/work' })
      expect(asked[0]).toStrictEqual({ toolHooks: false })
      expect(spawned[0].meta?.restore).not.toHaveProperty('observed')
      expect(observeHooks).not.toHaveBeenCalled()
    }
  })

  it('observed, the prepare puts the observe files in place and the spawn asks for them and marks the note', async () => {
    const { manager, spawned, argv, asked, observeHooks } = rig('observe')
    await manager.prepare({ account, cwd: '/work' })
    expect(observeHooks).toHaveBeenCalledTimes(1)
    manager.spawn({ account, cwd: '/work', slackNotify: true })
    expect(asked[0]).toStrictEqual({ toolHooks: true, observe: true })
    expect(argsText(argv[0])).toContain('observe.json')
    expect(spawned[0].meta?.restore).toMatchObject({ observed: true })
  })

  it('a codex session observed is marked in its note, with no hook files to write', async () => {
    const { manager, spawned, observeHooks } = rig('observe')
    await manager.prepare({ account: codexAccount, cwd: '/work' })
    manager.spawn({ account: codexAccount, cwd: '/work' })
    expect(observeHooks).not.toHaveBeenCalled()
    expect(spawned[0].meta?.restore).toMatchObject({ observed: true })
  })

  it('a prepare whose observe files failed does not fail the spawn', async () => {
    const { manager, spawned } = rig('observe')
    manager.observeHooks = async () => {
      throw new Error('EACCES')
    }
    await expect(manager.prepare({ account, cwd: '/work' })).resolves.toBeUndefined()
    manager.spawn({ account, cwd: '/work' })
    expect(spawned).toHaveLength(1)
  })

  // Ruling (fix round 1): a Claude session is marked only when it was given the observe files; one left on the plain
  // file (they could not be written) sends no observe lines and is not observed.
  it('a Claude session left on the plain file is not marked observed', async () => {
    const { manager, spawned, argv } = rig('observe', false)
    await manager.prepare({ account, cwd: '/work' })
    manager.spawn({ account, cwd: '/work' })
    expect(argsText(argv[0])).toContain('s.json')
    expect(spawned[0].meta?.restore).not.toHaveProperty('observed')
  })
})

// The Credentials list (credentials design §5): the inherited environment loses what the list hides before Astera adds its
// own variables, so an entry can never take away the session's identity, its Gateway token or a shared server's value.
describe('credentials hiding', () => {
  const caps = {
    context: { kind: 'implicit' as const, accounts: ['acc-1'], policyMode: 'compatibility' as const, executionMode: 'managed' as const },
    args: [],
    env: { LINEAR_API_KEY: 'from-astera' },
    given: ['linear'],
    gatewayGrant: ['mcp-linear'],
    skipped: []
  }
  const base = { PATH: process.env.PATH ?? '', GH_TOKEN: 'inherited', LINEAR_API_KEY: 'inherited-raw', KEEP: 'k' }
  const made = () => {
    const spawned: { opts: PtySpawnOptions }[] = []
    const factory: PtyFactory = (_file, _args, opts) => {
      spawned.push({ opts })
      return new FakePty()
    }
    const manager = new SessionManager(factory, makeDescriptors(process.platform), 100, 20, undefined, undefined, undefined, base)
    return { manager, spawned }
  }

  it('a session started after an entry is on has none of its variables', () => {
    const { manager, spawned } = made()
    manager.hiding = { get: () => ({ remove: ['GH_TOKEN'], set: { GH_CONFIG_DIR: 'C:/empty/gh' } }), damaged: () => false }
    manager.spawn({ account, cwd: os.tmpdir() })
    const env = spawned[0].opts.env ?? {}
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GH_CONFIG_DIR).toBe('C:/empty/gh')
    expect(env.KEEP).toBe('k')
  })

  it('never removes what Astera plants', () => {
    const { manager, spawned } = made()
    manager.capabilities = { get: () => caps, refresh: async () => {} }
    manager.hiding = { get: () => ({ remove: ['LINEAR_API_KEY', 'ASTERA_SESSION', 'ASTERA_GATEWAY_TOKEN'], set: {} }), damaged: () => false }
    const info = manager.spawn({ account, cwd: os.tmpdir(), orchEnv: { cliPath: 'C:/cli/astera.cmd', skillsPath: 'C:/u/skills', profileDir: 'C:/u' } })
    const env = spawned[0].opts.env ?? {}
    expect(env.LINEAR_API_KEY).toBe('from-astera')
    expect(env.ASTERA_SESSION).toBe(info.id)
    expect(env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  // Final review I3: the session's id names its own empty locations
  it('asks the hiding for the session\'s folder and its id', () => {
    const { manager } = made()
    const asked: [string, string | undefined][] = []
    manager.hiding = { get: (cwd, sessionId) => (asked.push([cwd, sessionId]), { remove: [], set: {} }), damaged: () => false }
    const info = manager.spawn({ account, cwd: os.tmpdir() })
    expect(asked).toEqual([[os.tmpdir(), info.id]])
  })
})

// The sandbox (sandbox design §6): a sandboxed Codex terminal session starts with `-a never` and the Astera permission
// profile in place of the bypass flag, on its own server (`--no-daemon`), with npm's cache in TEMP and, on Windows, its
// repository named safe for the sandbox's own account. A session without it starts with exactly today's arguments.
describe('the sandbox at spawn', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  /** A repository's top, its folder named `name` (a fresh temp folder by default). */
  const repo = (name?: string): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'astera-sbx-'))
    dirs.push(root)
    const top = name === undefined ? root : path.join(root, name)
    mkdirSync(path.join(top, '.git'), { recursive: true })
    return top
  }
  const daemon = (takesNoDaemon: boolean) => Object.assign(() => takesNoDaemon, { warm: async () => {} })
  const HOME = { linux: '/home/t', darwin: '/Users/t', win32: 'C:\\Users\\t' } as const
  const BASE = {
    linux: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    darwin: { PATH: '/usr/bin' },
    win32: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }
  } as const
  type Ready = NonNullable<SpawnChecks['codexWindowsReady']>
  /** Every Windows home reads set up unless a case says otherwise: the real question runs codex. */
  const checksFor = (platform: NodeJS.Platform, ready: Ready = async () => 'ready', hostSocketDir: string | null = null, codexExcludes?: SpawnChecks['codexExcludes'], appKeyFile?: string, readOnly?: readonly string[]): SpawnChecks => ({ linkLook: null,
    cwd: async () => 'present', gitBash: createGitBashResolver(async () => 'absent'), platform, now: Date.now, syncExists: () => true, log: () => {},
    codexWindowsReady: ready, hostSocketDir, ...(codexExcludes ? { codexExcludes } : {}), ...(appKeyFile ? { appKeyFile } : {}), ...(readOnly ? { readOnly } : {})
  })
  /** The codex version the probe answers: '0.160.0', the floor, unless a case says otherwise (null: unreadable,
   *  undefined: no codex) */
  const versionOf = (v: string | null | undefined) => Object.assign((_cli: 'claude' | 'codex') => v, { warm: async () => {} })
  const rig = (platform: 'linux' | 'darwin' | 'win32', o: { noDaemon?: boolean; ready?: Ready; hostSocketDir?: string | null; codex?: string | null; noVersionProbe?: true; excludes?: SpawnChecks['codexExcludes']; appKeyFile?: string; readOnly?: readonly string[]; base?: Record<string, string> } = {}) => {
    const argv: string[][] = []
    const spawned: PtySpawnOptions[] = []
    const manager = new SessionManager(
      (_f, a, opts) => (argv.push(a as string[]), spawned.push(opts), new FakePty()),
      makeDescriptors(platform, HOME[platform], undefined, daemon(o.noDaemon ?? true)),
      100, 20, HOME[platform], undefined, [], { ...BASE[platform], ...(o.base ?? {}) }, checksFor(platform, o.ready, o.hostSocketDir ?? null, o.excludes, o.appKeyFile, o.readOnly)
    )
    if (!o.noVersionProbe) manager.codexVersion = versionOf('codex' in o ? o.codex : '0.160.0')
    return { manager, argv, spawned }
  }
  /** What the builders give for this folder, from the session's own environment and home. */
  const expected = async (platform: 'linux' | 'darwin' | 'win32', cwd: string) => {
    const layout = await gitLayoutOf(cwd)
    const env: Record<string, string> = { ...BASE[platform] }
    const denied = [...sensitiveLocations(platform, env, HOME[platform]), ...credentialStoreDenies(platform, env, HOME[platform])]
    return { args: codexSandboxArgs({ platform, layout, denied, readOnly: [] }), env: codexSandboxEnv({ platform, layout, tmpDir: os.tmpdir() }), layout }
  }
  /** The codex arguments after Astera's runner (Windows, fix round 2) and cmd.exe's wrapper, when win32 found a shim. */
  const codexArgs = (a: string[]): string[] => {
    const cmd = a[1] === CODEX_CHECK_FLAG ? a.slice(3) : a
    return cmd[0] === '/d' ? cmd.slice(4) : cmd
  }
  /** The runner a Windows Codex check goes through (checkRunner.ts) */
  const RUNNER = { execPath: 'C:\\Astera\\Astera.exe', runnerPath: 'C:\\Astera\\sandbox-check.js' }

  // Task K: a Task's check of a sandboxed Codex worker runs inside the same sandbox, as `codex sandbox` with the session's own
  // profile (sessionSandboxArgs without `-a never`: the S2 measurement's shape, scripts/measure/s2.mjs) and the session's
  // own environment, after the Credentials list's hiding. On Windows the very deny list matters: Codex asks to revoke the
  // deny-read ACEs a launch's list lacks (Task K part 1), which Windows keeps today but not once Codex's revoke works
  it("starts a sandboxed Codex worker's check as `codex sandbox` with the session's own profile, environment and hiding", async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cwd = repo()
      const { manager } = rig(platform, { base: { SECRET_TOKEN: 's', KEEP: 'k' } })
      manager.hiding = { get: () => ({ remove: ['SECRET_TOKEN'], set: {} }), damaged: () => false }
      manager.codexCheckRunner = codexCheckRunner(RUNNER)
      const launch = await manager.checkLaunch({ account: codexAccount, cwd, command: 'npm run test' })
      const want = await expected(platform, cwd)
      // Fix round 2: on Windows the check's shell says it started before it runs, through Astera's runner (checkRunner.ts)
      const shell = platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', `echo ${CHECK_STARTED_MARK}& npm run test`] : ['sh', '-c', 'npm run test']
      expect(codexArgs(launch.args as string[]), platform).toEqual(['sandbox', ...want.args.slice(2), '--', ...shell])
      expect(launch.env, platform).toMatchObject({ ...want.env, KEEP: 'k' })
      expect(launch.env, platform).not.toHaveProperty('SECRET_TOKEN')
      if (platform === 'win32') {
        expect(launch.file).toBe(RUNNER.execPath)
        expect((launch.args as string[]).slice(0, 2)).toEqual([RUNNER.runnerPath, CODEX_CHECK_FLAG])
        expect(launch.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' })
        // Fix round 4 (R1): it says it goes through the runner, which takes the reason file's name out of the check's env
        expect(launch.runner).toBe(true)
      } else {
        // macOS and Linux: straight in its pty, as before
        expect(launch.file).not.toBe(RUNNER.execPath)
        expect(launch.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
        expect(launch).not.toHaveProperty('runner')
      }
    }
  })

  // Fix round 2: a process without the runner cannot tell a Windows sandbox that failed from a check that failed, so it
  // does not start one, before asking Codex anything
  it('refuses a Windows Codex check where the process has no runner for it', async () => {
    let asked = 0
    const { manager } = rig('win32', { ready: async () => (asked++, 'ready') })
    await expect(manager.checkLaunch({ account: codexAccount, cwd: repo(), command: 'npm test' })).rejects.toThrow('SANDBOX_UNAVAILABLE: no-check-runner')
    expect(asked).toBe(0)
  })

  // codex hands the command to cmd.exe quoted with backslash escapes (windows-sandbox-rs/src/winutil.rs:72-112 at
  // rust-v0.160.0), which cmd.exe does not read (S2 found it, s2.mjs WIN32_PROBES): a line holding a double quote goes
  // through a script file the sandbox may read, in the temp folder
  it('a Windows check line holding a double quote reaches cmd.exe through a script file', async () => {
    const { manager } = rig('win32')
    manager.codexCheckRunner = codexCheckRunner(RUNNER)
    const line = 'python "my script.py" --flag'
    const launch = await manager.checkLaunch({ account: codexAccount, cwd: repo(), command: line })
    const args = codexArgs(launch.args as string[])
    const tail = args.slice(args.indexOf('--') + 1)
    expect(tail.slice(0, 3)).toEqual(['cmd.exe', '/d', '/c'])
    expect(tail[3]).toMatch(/\.cmd$/)
    expect(path.dirname(tail[3])).toBe(path.join(os.tmpdir(), 'astera-checks'))
    expect(readFileSync(tail[3], 'utf8')).toContain(line)
  })

  it("refuses a Windows check where the account's sandbox is not set up, naming the account (E5)", async () => {
    const { manager } = rig('win32', { ready: async () => 'not-set-up' })
    manager.codexCheckRunner = codexCheckRunner(RUNNER)
    await expect(manager.checkLaunch({ account: codexAccount, cwd: repo(), command: 'npm test' })).rejects.toThrow(`SANDBOX_UNAVAILABLE: windows-setup codex ${codexAccount.id}`)
  })

  // Task K (the person's Q5): every check, sandboxed or not, starts without what the Credentials list hides from a session
  // in its folder
  // Fix round 2: with the names it took, never the values, which the check's result shows
  it('a check environment is the base without what the Credentials list hides for its folder, and names what it took', () => {
    const { manager } = rig('linux')
    manager.hiding = { get: (cwd) => ({ remove: cwd === '/w' ? ['SECRET_TOKEN'] : [], set: {} }), damaged: () => false }
    expect(manager.checkEnv({ PATH: '/bin', SECRET_TOKEN: 's' }, '/w')).toEqual({ env: { PATH: '/bin' }, hidden: ['SECRET_TOKEN'] })
    expect(manager.checkEnv({ PATH: '/bin', SECRET_TOKEN: 's' }, '/x')).toEqual({ env: { PATH: '/bin', SECRET_TOKEN: 's' }, hidden: [] })
  })

  it('a sandboxed Codex session starts with -a never and the profile, not the bypass flag', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cwd = repo()
      const { manager, argv, spawned } = rig(platform)
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      const info = manager.spawn({ account: codexAccount, cwd, sandbox: true, bypassPermissions: true, initialPrompt: 'go' })
      const want = await expected(platform, cwd)
      expect(codexArgs(argv[0]), platform).toEqual(['-c', 'check_for_update_on_startup=false', '--no-daemon', ...want.args, 'go'])
      expect(argv[0]).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      // The E6 list and the OS credential store come from the session's own environment and home
      const profile = want.args[3]
      expect(profile).toContain(`"${HOME[platform].replace(/\\/g, '/')}/.ssh"="deny"`)
      if (platform === 'linux') expect(profile).toContain('"/run/user/1000/bus"="deny"')
      if (platform === 'darwin') expect(profile).toContain('"/Users/t/Library/Keychains"="deny"')
      if (platform === 'win32') expect(profile).toContain('"C:/Users/t/AppData/Roaming/GitHub CLI"="deny"')
      // Marked in the info and the note, which a Host handing the session back reads: Codex's own sandbox on every OS
      expect(info.sandboxed).toBe(true)
      expect(info.sandboxKind, platform).toBe('sandbox')
      expect(spawned[0].meta?.restore).toMatchObject({ sandboxed: true, sandboxKind: 'sandbox' })
      expect(sessionInfoFromNote({ kind: 'session', id: info.id, restore: spawned[0].meta!.restore! })).toMatchObject({ sandboxed: true, sandboxKind: 'sandbox' })
    }
  })

  // Final fix pass (minor 4): on Windows the profile names every worktree's git files, and with enough of them the command
  // line passes what cmd.exe (8191) or CreateProcess (32767) carries; the start is refused, at the prepare and at the
  // spawn, rather than launched broken with a generic error
  it('a sandboxed win32 Codex start whose command line would not fit is refused before the spawn', async () => {
    const cwd = repo()
    for (let i = 0; i < 400; i++) mkdirSync(path.join(cwd, '.git', 'worktrees', `worktree-with-a-long-name-${String(i).padStart(4, '0')}`), { recursive: true })
    const { manager, spawned } = rig('win32')
    await expect(manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: command-too-long$/)
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
    expect(spawned).toHaveLength(0)
    // A few worktrees fit
    const small = repo()
    for (let i = 0; i < 3; i++) mkdirSync(path.join(small, '.git', 'worktrees', `w${i}`), { recursive: true })
    const ok = rig('win32')
    await ok.manager.prepare({ account: codexAccount, cwd: small, sandbox: true })
    expect(ok.manager.spawn({ account: codexAccount, cwd: small, sandbox: true }).sandboxed).toBe(true)
  })

  // Final review I2: the sandbox was measured on codex 0.160.0 (ENFORCE_MIN.codex); an older codex, one whose version
  // cannot be read, or none, could ignore the profile and run under its own config, so the start is refused before
  // anything is written, and again at the spawn if the codex changed in between
  it('a sandboxed Codex start needs codex 0.160.0 or later, at the prepare and at the spawn', async () => {
    const cases: Array<[string | null | undefined, RegExp]> = [
      ['0.159.0', /^SANDBOX_UNAVAILABLE: cli-too-old codex 0\.159\.0 0\.160\.0$/],
      [null, /^SANDBOX_UNAVAILABLE: cli-version-unknown codex$/],
      [undefined, /^SANDBOX_UNAVAILABLE: cli-missing codex$/]
    ]
    for (const [codex, refusal] of cases) {
      const cwd = repo()
      const { manager, spawned } = rig('linux', { codex })
      await expect(manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(refusal)
      expect(existsSync(path.join(cwd, '.git', 'commondir')), String(codex)).toBe(false)
      expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
      expect(spawned).toHaveLength(0)
      // Unsandboxed, the same codex starts as before
      await manager.prepare({ account: codexAccount, cwd })
      manager.spawn({ account: codexAccount, cwd })
      expect(spawned).toHaveLength(1)
    }
    // A process with no version probe cannot tell, and refuses
    const none = rig('linux', { noVersionProbe: true })
    await expect(none.manager.prepare({ account: codexAccount, cwd: repo(), sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: cli-version-unknown codex$/)
    // The floor itself starts; a codex downgraded after the prepare is refused at the spawn
    const cwd = repo()
    const ok = rig('linux')
    await ok.manager.prepare({ account: codexAccount, cwd, sandbox: true })
    ok.manager.codexVersion = versionOf('0.159.9')
    expect(() => ok.manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: cli-too-old codex 0\.159\.9 0\.160\.0$/)
    ok.manager.codexVersion = versionOf('0.161.2')
    expect(ok.manager.spawn({ account: codexAccount, cwd, sandbox: true }).sandboxed).toBe(true)
  })

  // Final fix pass (C2): on macOS and Linux the folder the Host's socket is in is denied, so the session reaches the Host
  // only through the loopback with its workload token; on Windows the Host's pipe is no file and nothing is added
  it('denies the folder of the Host’s socket on macOS and Linux', async () => {
    const dirs = { linux: '/tmp/astera-host-0123456789ab-v4', darwin: '/var/folders/x/T/astera-host-0123456789ab-v4', win32: null } as const
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cwd = repo()
      const { manager, argv } = rig(platform, { hostSocketDir: dirs[platform] })
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      const profile = codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
      if (platform === 'linux') expect(profile).toContain('"/tmp/astera-host-0123456789ab-v4"="deny"')
      if (platform === 'darwin') {
        expect(profile).toContain('"/var/folders/x/T/astera-host-0123456789ab-v4"="deny"')
        expect(profile).toContain('"/private/var/folders/x/T/astera-host-0123456789ab-v4"="deny"')
      }
      if (platform === 'win32') expect(profile).not.toContain('astera-host-')
    }
  })

  // Sandbox follow-ups, item 1: the app's key lets a process be the app to the Host (spawn anything, be the person in the
  // records), so the profile denies it on every OS; the Host key beside it stays readable for the loopback's proof
  it('denies the app key on every OS, and leaves the Host key readable', async () => {
    const files = { linux: '/home/t/.config/astera/host/app.key', darwin: '/Users/t/Library/Application Support/astera/host/app.key', win32: 'C:\\Users\\t\\AppData\\Roaming\\astera\\host\\app.key' } as const
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cwd = repo()
      const { manager, argv } = rig(platform, { appKeyFile: files[platform] })
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      const profile = codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
      expect(profile, platform).toContain(`"${files[platform].replace(/\\/g, '/')}"="deny"`)
      expect(profile, platform).not.toContain('host.key')
    }
  })

  // Task E (2026-10-28): what the app and the Host run outside any sandbox is in the profile folder, so a sandboxed
  // session's profile keeps that folder read-only on every OS, wherever the session's folder is; the app key in it stays
  // denied and the Host key readable
  it("keeps Astera's profile folder read on every OS, with the app key in it denied", async () => {
    const dirs = { linux: '/home/t/.config/astera', darwin: '/Users/t/Library/Application Support/astera', win32: 'C:\\Users\\t\\AppData\\Roaming\\astera' } as const
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cwd = repo()
      const sep = platform === 'win32' ? '\\' : '/'
      const dir = dirs[platform].replace(/\\/g, '/')
      const { manager, argv } = rig(platform, { readOnly: [dir], appKeyFile: [dirs[platform], 'host', 'app.key'].join(sep) })
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      const profile = codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
      expect(profile, platform).toContain(`"${dir}"="read"`)
      expect(profile, platform).toContain(`"${dir}/host/app.key"="deny"`)
      expect(profile, platform).not.toContain('host.key')
    }
  })

  // Task E fix round 2 (the person's decision): a sandboxed start whose work folder holds the home folder starts as it
  // does today, and its sink is told once; a project folder inside the home folder, and a start outside the sandbox, are
  // not told
  it('tells a sandboxed start whose work folder holds the home folder, once, and starts it as today', async () => {
    const cwd = repo()
    const home = path.join(cwd, 'home')
    mkdirSync(home)
    const argv: string[][] = []
    const opened: PtySpawnOptions[] = []
    const manager = new SessionManager((_f, a, o) => (argv.push(a as string[]), opened.push(o), new FakePty()), makeDescriptors('linux', home, undefined, daemon(true)),
      100, 20, home, undefined, [], { ...BASE.linux }, checksFor('linux'))
    manager.codexVersion = versionOf('0.160.0')
    const told: Array<[string, string[]]> = []
    manager.sandboxWarn = { claudeUsernsRestricted: () => true, warn: (id, ws) => void told.push([id, [...ws]]) }
    const said: string[] = []
    manager.onData = (e) => void said.push(e.data)
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    const info = manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(argv).toHaveLength(1)
    // Codex: the home folder only, never the Claude-only Ubuntu warning
    expect(told).toEqual([[info.id, ['homeInWorkFolder']]])
    // Task E fix round 3 (re-review Important 1): the warnings ride the info and the note, as sandboxKind does, for the tab
    // to show above the terminal; nothing is written into the pty's stream, which a CLI's alternate screen hides
    expect(info.sandboxWarnings).toEqual(['homeInWorkFolder'])
    expect(opened[0].meta?.restore).toMatchObject({ sandboxed: true, sandboxWarnings: ['homeInWorkFolder'] })
    expect(said.join('')).not.toContain('[Astera]')
    expect(manager.list().find((s) => s.id === info.id)?.sandboxWarnings).toEqual(['homeInWorkFolder'])
    const project = path.join(home, 'p')
    mkdirSync(path.join(project, '.git'), { recursive: true })
    await manager.prepare({ account: codexAccount, cwd: project, sandbox: true })
    manager.spawn({ account: codexAccount, cwd: project, sandbox: true })
    await manager.prepare({ account: codexAccount, cwd })
    manager.spawn({ account: codexAccount, cwd })
    expect(argv).toHaveLength(3)
    expect(told).toHaveLength(1)
  })

  // Task E fix round 5 (rule E5): every path Astera names for a sandboxed Codex start is looked at against the session's
  // writable folders. A link the session cannot change (a dotfile manager's ~/.config, with a project work folder) is
  // followed, a missing entry under it too; a link it could change (the work folder holds it) leaves the entry as given:
  // on Linux Codex then refuses every command, and the session is told so; elsewhere nothing refuses it, so the start is
  // refused (`linked-path`), its log naming the link
  describe('a link on a path the sandbox names', () => {
    const linkedHome = (): { home: string; proj: string } => {
      // Outside /tmp, which a sandboxed session may write (so a link there is one it could change): Linux's temp folder is
      // /tmp, so the fixture goes in /dev/shm there
      const root = mkdtempSync(path.join(process.platform === 'linux' && existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'astera-links-'))
      dirs.push(root)
      const base = realpathSync.native(root).replace(/\\/g, '/')
      const home = `${base}/home`
      mkdirSync(`${home}/dots/config/gh`, { recursive: true })
      mkdirSync(`${home}/proj/.git`, { recursive: true })
      symlinkSync(`${home}/dots/config`, `${home}/.config`, process.platform === 'win32' ? 'junction' : 'dir')
      return { home, proj: `${home}/proj` }
    }
    const linkRig = (platform: 'linux' | 'darwin' | 'win32', home: string) => {
      const argv: string[][] = []
      const logs: string[] = []
      const manager = new SessionManager((_f, a) => (argv.push(a as string[]), new FakePty()), makeDescriptors(platform, home, undefined, daemon(true)),
        100, 20, home, undefined, [], { ...BASE[platform] }, { ...checksFor(platform), log: (m) => void logs.push(m), linkLook: nodeLinkLook, readOnly: [`${home}/.config/astera`] })
      manager.codexVersion = versionOf('0.160.0')
      const told: Array<[string, string[]]> = []
      manager.sandboxWarn = { claudeUsernsRestricted: () => false, warn: (id, ws) => void told.push([id, [...ws]]) }
      return { manager, argv, logs, told }
    }

    it('follows a link the session cannot change, on every entry, a missing one included', async () => {
      for (const platform of ['linux', 'darwin'] as const) {
        const { home, proj } = linkedHome()
        const r = linkRig(platform, home)
        await r.manager.prepare({ account: codexAccount, cwd: proj, sandbox: true })
        const info = r.manager.spawn({ account: codexAccount, cwd: proj, sandbox: true })
        const profile = codexArgs(r.argv[0]).find((a) => a.startsWith('permissions='))!
        expect(profile, platform).toContain(`"${home}/dots/config/gh"="deny"`)
        expect(profile, platform).toContain(`"${home}/dots/config/gcloud"="deny"`)
        expect(profile, platform).toContain(`"${home}/dots/config/astera"="read"`)
        expect(profile, platform).not.toContain(`${home}/.config/`)
        expect(info.sandboxWarnings, platform).toBeUndefined()
      }
    })

    it('on Linux leaves an entry through a link in the work folder as given, and tells the session Codex will refuse its commands', async () => {
      const { home } = linkedHome()
      const r = linkRig('linux', home)
      await r.manager.prepare({ account: codexAccount, cwd: home, sandbox: true })
      const info = r.manager.spawn({ account: codexAccount, cwd: home, sandbox: true })
      const profile = codexArgs(r.argv[0]).find((a) => a.startsWith('permissions='))!
      expect(profile).toContain(`"${home}/.config/gh"="deny"`)
      expect(profile).toContain(`"${home}/.config/gcloud"="deny"`)
      expect(profile).toContain(`"${home}/.config/astera"="read"`)
      expect(info.sandboxWarnings).toEqual(['linkInWorkFolder', 'homeInWorkFolder'])
      expect(r.told).toEqual([[info.id, ['linkInWorkFolder', 'homeInWorkFolder']]])
    })

    it('elsewhere refuses a start whose entry goes through a link in the work folder, naming the link in the log', async () => {
      // macOS and (fix round 6, re-review 2) Windows, whose sandbox resolves every path it protects and pins no link
      for (const platform of ['darwin', 'win32'] as const) {
        const { home } = linkedHome()
        const r = linkRig(platform, home)
        await expect(r.manager.prepare({ account: codexAccount, cwd: home, sandbox: true }), platform).rejects.toThrow(/^SANDBOX_UNAVAILABLE: linked-path$/)
        expect(r.logs.some((l) => l.includes(`${home}/.config`)), platform).toBe(true)
        expect(r.argv, platform).toHaveLength(0)
      }
    })
  })

  // Task E fix round 6 (Important): Codex's Windows sandbox makes a missing deny-read path a folder before it denies it
  // (windows-sandbox-rs/src/deny_read_acl.rs:58-76 at rust-v0.160.0), so a missing ~/.git-credentials became an empty
  // folder where git's credential store wants a file. On Windows a file entry that is not there at the start is left out;
  // a missing folder stays named (an empty folder there is harmless); nothing changes off Windows
  it('on Windows leaves out a deny entry for a file that is not there, and keeps one for a missing folder', async () => {
    const base = realpathSync.native(repo()).replace(/\\/g, '/')
    const home = `${base}/home`
    const profile = `${base}/profile`
    mkdirSync(home)
    mkdirSync(`${profile}/host`, { recursive: true })
    writeFileSync(`${home}/.git-credentials`, '')
    const cwd = repo()
    const start = async (platform: 'win32' | 'linux'): Promise<string> => {
      const argv: string[][] = []
      const env = platform === 'win32' ? { Path: 'C:\\Windows', APPDATA: `${home}/AppData/Roaming` } : { ...BASE.linux }
      const manager = new SessionManager((_f, a) => (argv.push(a as string[]), new FakePty()), makeDescriptors(platform, home, undefined, daemon(true)),
        100, 20, home, undefined, [], env, { ...checksFor(platform), linkLook: nodeLinkLook, appKeyFile: `${profile}/host/app.key` })
      manager.codexVersion = versionOf('0.160.0')
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      return codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
    }
    const win = await start('win32')
    expect(win).toContain(`"${home}/.git-credentials"="deny"`)
    expect(win).not.toContain(`${home}/.npmrc`)
    expect(win).toContain(`"${home}/.ssh"="deny"`)
    expect(win).toContain(`"${home}/AppData/Roaming/gcloud"="deny"`)
    // The app key is a file too: left out while it is not there, named once it is
    expect(win).not.toContain('app.key')
    writeFileSync(`${profile}/host/app.key`, 'k')
    expect(await start('win32')).toContain(`"${profile}/host/app.key"="deny"`)
    // Off Windows a missing file stays named: nothing there makes it a folder
    expect(await start('linux')).toContain(`"${home}/.npmrc"="deny"`)
  })

  // Task E fix round 1: every read-only folder the wiring names (the profile and the places Astera writes code or an
  // installer to and runs unsandboxed) is a `read` entry; the win32 session goes through cmd.exe, so one with a forbidden
  // character refuses the start
  it("keeps every read-only folder the wiring names read, and refuses a win32 one cmd.exe cannot carry", async () => {
    const roots = ['C:/Users/t/AppData/Roaming/astera', 'C:/Users/t/AppData/Local/astera/host-runtime', 'C:/Users/t/AppData/Local/astera-updater', 'C:/Users/t/AppData/Local/astera/app']
    const cwd = repo()
    const { manager, argv } = rig('win32', { readOnly: roots })
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    const profile = codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
    for (const r of roots) expect(profile).toContain(`"${r}"="read"`)
    const bad = rig('win32', { readOnly: ['C:/Users/t/AppData/Local/astera 100%/host-runtime'] })
    // Task E fix round 3: not the work folder, so its own code, whose words do not name the work folder (re-review Minor 6)
    await expect(bad.manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: named-path-unsafe$/)
    expect(() => bad.manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
    expect(bad.argv).toHaveLength(0)
  })

  // Final fix pass, part 2 (B): every other Host's folder beside this profile's (another profile's Host, such as the dev
  // app's) is denied too, as the prepare found them: the folder is read once, so a Host started after it is not
  it('denies every Host folder beside this one that is there when the session starts', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'astera-hosts-'))
    dirs.push(parent)
    const slashed = (p: string): string => p.replace(/\\/g, '/')
    const own = slashed(path.join(parent, 'astera-host-aaaaaaaaaaaa-v4'))
    const dev = slashed(path.join(parent, 'astera-host-bbbbbbbbbbbb-v4'))
    for (const d of [own, dev, path.join(parent, 'unrelated')]) mkdirSync(d)
    // Each Host folder holds its socket: an empty one names no Host and is left out (mac check)
    writeFileSync(path.join(dev, 'sock'), '')
    const cwd = repo()
    const { manager, argv } = rig('linux', { hostSocketDir: own })
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    mkdirSync(path.join(parent, 'astera-host-cccccccccccc-v4'))
    writeFileSync(path.join(parent, 'astera-host-cccccccccccc-v4', 'sock'), '')
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    const profile = codexArgs(argv[0]).find((a) => a.startsWith('permissions='))!
    expect(profile).toContain(`"${own}"="deny"`)
    expect(profile).toContain(`"${dev}"="deny"`)
    expect(profile).not.toContain('unrelated')
    expect(profile).not.toContain('astera-host-cccccccccccc')
  })

  it('its environment has the npm cache and, on win32, safe.directory', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const cwd = repo()
      const { manager, spawned } = rig(platform)
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      const env = spawned[0].env ?? {}
      const want = await expected(platform, cwd)
      expect(env.npm_config_cache).toBe(`${os.tmpdir().replace(/\\/g, '/').replace(/\/+$/, '')}/astera-npm-cache`)
      expect(env).toMatchObject(want.env)
      // Final fix pass (C1): on every OS the git files a read entry keeps are made first, a commondir naming the git
      // directory itself and an empty modules folder
      expect(readFileSync(path.join(cwd, '.git', 'commondir'), 'utf8'), platform).toBe('.\n')
      expect(existsSync(path.join(cwd, '.git', 'modules')), platform).toBe(true)
      if (platform === 'win32') {
        expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: want.layout!.top })
        // win32 only: git may later read a config.worktree, and the Windows sandbox would create a missing one
        expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(true)
      } else {
        expect(env.GIT_CONFIG_COUNT).toBeUndefined()
        expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(false)
      }
    }
  })

  // The elevated sandbox runs the session as an account of its own, which cannot read the person's global excludes: the
  // prepare has a copy written in TEMP once every check has passed, and the session's git is pointed at it after the
  // safe directory. macOS and Linux sessions read the person's own, and nothing is written for them
  it('a sandboxed win32 Codex session reads a copy of the person’s global excludes', async () => {
    const file = 'C:/t/astera-git-excludes-0123456789ab'
    let asked = 0
    const excludes = async (): Promise<string | null> => (asked++, file)
    for (const platform of ['win32', 'linux'] as const) {
      const cwd = repo()
      const { manager, spawned } = rig(platform, { excludes })
      await manager.prepare({ account: codexAccount, cwd, sandbox: true })
      manager.spawn({ account: codexAccount, cwd, sandbox: true })
      const env = spawned[0].env ?? {}
      if (platform === 'win32')
        expect(env).toMatchObject({
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'safe.directory',
          GIT_CONFIG_VALUE_0: (await gitLayoutOf(cwd))!.top,
          GIT_CONFIG_KEY_1: 'core.excludesFile',
          GIT_CONFIG_VALUE_1: file
        })
      else expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    }
    expect(asked).toBe(1)
    // A start refused (the account's Windows sandbox not set up) writes nothing
    const unready = rig('win32', { excludes, ready: async () => 'not-set-up' })
    await expect(unready.manager.prepare({ account: codexAccount, cwd: repo(), sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-setup codex /)
    expect(asked).toBe(1)
    // No copy (no excludes, or it could not be written): the environment is as before
    const cwd = repo()
    const none = rig('win32', { excludes: async () => null })
    await none.manager.prepare({ account: codexAccount, cwd, sandbox: true })
    none.manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(none.spawned[0].env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory' })
    expect(none.spawned[0].env).not.toHaveProperty('GIT_CONFIG_KEY_1')
    // An unsandboxed session asks for none
    const plain = rig('win32', { excludes })
    await plain.manager.prepare({ account: codexAccount, cwd })
    plain.manager.spawn({ account: codexAccount, cwd })
    expect(asked).toBe(1)
    expect(plain.spawned[0].env?.GIT_CONFIG_COUNT).toBeUndefined()
  })

  // Task 5 fix round 1: the person's own GIT_CONFIG_* entries the session inherits stay, with the safe.directory after them
  it('a win32 session keeps the GIT_CONFIG entries it inherits', async () => {
    const cwd = repo()
    const spawned: PtySpawnOptions[] = []
    const manager = new SessionManager((_f, _a, o) => (spawned.push(o), new FakePty()), makeDescriptors('win32', HOME.win32, undefined, daemon(true)),
      100, 20, HOME.win32, undefined, [], { ...BASE.win32, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }, checksFor('win32'))
    manager.codexVersion = versionOf('0.160.0')
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(spawned[0].env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: (await gitLayoutOf(cwd))!.top
    })
  })

  it("an unsandboxed session's arguments are unchanged", async () => {
    for (const sandbox of [undefined, false]) {
      const cwd = repo()
      const { manager, argv, spawned } = rig('win32')
      await manager.prepare({ account: codexAccount, cwd, ...(sandbox === undefined ? {} : { sandbox }) })
      const info = manager.spawn({ account: codexAccount, cwd, bypassPermissions: true, initialPrompt: 'go', ...(sandbox === undefined ? {} : { sandbox }) })
      expect(codexArgs(argv[0])).toEqual(['-c', 'check_for_update_on_startup=false', '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', 'go'])
      const env = spawned[0].env ?? {}
      expect(env.npm_config_cache).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(info).not.toHaveProperty('sandboxed')
      expect(info).not.toHaveProperty('sandboxKind')
      expect(spawned[0].meta?.restore).not.toHaveProperty('sandboxed')
      expect(spawned[0].meta?.restore).not.toHaveProperty('sandboxKind')
      // Nothing is written into the repository for it
      expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(false)
      expect(existsSync(path.join(cwd, '.git', 'commondir'))).toBe(false)
      expect(existsSync(path.join(cwd, '.git', 'modules'))).toBe(false)
    }
    const { manager, argv } = rig('linux')
    await manager.prepare({ account, cwd: os.tmpdir() })
    manager.spawn({ account, cwd: os.tmpdir(), bypassPermissions: true, initialPrompt: 'go' })
    expect(argv[0]).toEqual(['--dangerously-skip-permissions', '--', 'go'])
  })

  // Task 5 fix round 1: refused at the prepare, which a roll awaits before its kill, so a roll that would be refused
  // leaves the session it would replace running
  it('a codex without --no-daemon refuses a sandboxed start', async () => {
    const cwd = repo()
    const { manager, spawned } = rig('linux', { noDaemon: false })
    await expect(manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: codex-daemon codex$/)
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
    expect(spawned).toHaveLength(0)
    // Unsandboxed, the same codex starts as before
    await manager.prepare({ account: codexAccount, cwd })
    manager.spawn({ account: codexAccount, cwd })
    expect(spawned).toHaveLength(1)
  })

  it('refuses a sandboxed win32 start whose folder holds a cmd.exe character', async () => {
    const cwd = repo('a&b')
    const w = rig('win32')
    await expect(w.manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: path-unsafe$/)
    expect(() => w.manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
    expect(w.spawned).toHaveLength(0)
    // Elsewhere nothing goes through cmd.exe
    const l = rig('linux')
    await l.manager.prepare({ account: codexAccount, cwd, sandbox: true })
    l.manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(l.spawned).toHaveLength(1)
  })

  it('refuses a sandboxed win32 start whose denied locations hold a cmd.exe character', async () => {
    const cwd = repo()
    const argv: string[][] = []
    const home = 'C:\\Users\\100%'
    const logs: string[] = []
    const manager = new SessionManager((_f, a) => (argv.push(a as string[]), new FakePty()), makeDescriptors('win32', home, undefined, daemon(true)),
      100, 20, home, undefined, [], { Path: 'C:\\Windows' }, { ...checksFor('win32'), log: (m) => void logs.push(m) })
    manager.codexVersion = versionOf('0.160.0')
    // A login folder in the home, not the work folder: its own code, and the log names the path (Task E fix round 3,
    // re-review Minor 6), at the prepare and again at the spawn
    await expect(manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: named-path-unsafe$/)
    expect(logs.filter((l) => l.includes('C:/Users/100%/.ssh'))).toHaveLength(1)
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: /)
    expect(argv).toHaveLength(0)
  })

  // The spawn asks again for itself: what it starts with is the environment it builds then, and the codex it finds now
  it('the spawn keeps its own checks, for a codex and an environment that changed since the prepare', async () => {
    const cwd = repo()
    let takes = true
    const flipping = Object.assign(() => takes, { warm: async () => {} })
    let appData = 'C:\\Users\\t\\AppData\\Roaming'
    const spawned: PtySpawnOptions[] = []
    const logs: string[] = []
    const manager = new SessionManager((_f, _a, o) => (spawned.push(o), new FakePty()), makeDescriptors('win32', HOME.win32, undefined, flipping),
      100, 20, HOME.win32, undefined, [], () => ({ Path: 'C:\\Windows', APPDATA: appData }), { ...checksFor('win32'), log: (m) => void logs.push(m) })
    manager.codexVersion = versionOf('0.160.0')
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    takes = false
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: codex-daemon codex$/)
    takes = true
    appData = 'C:\\Users\\t\\AppData\\R&D'
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: named-path-unsafe$/)
    // The log names the path the spawn refused for (Task E fix round 3, re-review Minor 6)
    expect(logs.some((l) => l.includes('C:/Users/t/AppData/R&D/GitHub CLI'))).toBe(true)
    expect(spawned).toHaveLength(0)
    appData = 'C:\\Users\\t\\AppData\\Roaming'
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(spawned).toHaveLength(1)
  })

  it('Enforce and the sandbox together give both sets of -c', async () => {
    const cwd = repo()
    const { manager, argv, spawned } = rig('linux')
    manager.capabilities = {
      get: () => ({ context: { kind: 'implicit', accounts: [codexAccount.id], policyMode: 'enforce', executionMode: 'managed' }, args: [], env: {}, given: [], gatewayGrant: [], skipped: [] }),
      refresh: async () => {}
    }
    manager.enforceHooks = async () => 'ok'
    manager.enforce = { args: () => ['-c', 'hooks.PreToolUse=[x]', '-c', 'hooks.state={y}'] }
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    manager.spawn({ account: codexAccount, cwd, sandbox: true, initialPrompt: 'go' })
    const want = await expected('linux', cwd)
    expect(argv[0]).toEqual(['-c', 'check_for_update_on_startup=false', '-c', 'hooks.PreToolUse=[x]', '-c', 'hooks.state={y}', '--no-daemon', ...want.args, 'go'])
    expect(spawned[0].meta?.restore).toMatchObject({ enforced: true, sandboxed: true })
  })

  // The synchronous spawn cannot read git safely, so a sandboxed spawn whose folder `prepare` did not read refuses
  it('a sandboxed spawn nobody prepared for the sandbox refuses with not-prepared', async () => {
    const cwd = repo()
    const { manager, spawned } = rig('linux')
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    await manager.prepare({ account: codexAccount, cwd })
    expect(() => manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    expect(spawned).toHaveLength(0)
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(spawned).toHaveLength(1)
  })

  // Windows readiness (inventory §23.3): an account whose Codex home has no elevated setup would bring up Windows'
  // administrator prompt at its first command, so the start is refused at the prepare, naming the account the person
  // can set up (설정하기), and nothing is written into the repository for it
  it('a sandboxed win32 Codex start on an account not set up refuses with windows-setup', async () => {
    const cwd = repo()
    const asked: Array<string | null> = []
    const notSetUp: Ready = async ({ codexHome }) => (asked.push(codexHome), 'not-set-up')
    const w = rig('win32', { ready: notSetUp })
    await expect(w.manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-setup codex acc-cx$/)
    // The account's own home is the one asked
    expect(asked).toEqual([codexAccount.configDir])
    expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(false)
    expect(existsSync(path.join(cwd, '.git', 'commondir'))).toBe(false)
    expect(() => w.manager.spawn({ account: codexAccount, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    expect(w.spawned).toHaveLength(0)
    // A process that cannot ask refuses the same way: a sandboxed start on a home nobody asked about is not risked
    const none = new SessionManager((_f, _a, o) => (w.spawned.push(o), new FakePty()), makeDescriptors('win32', HOME.win32, undefined, daemon(true)),
      100, 20, HOME.win32, undefined, [], { ...BASE.win32 }, { ...checksFor('win32'), codexWindowsReady: undefined })
    none.codexVersion = versionOf('0.160.0')
    await expect(none.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-setup codex acc-cx$/)
    // Unsandboxed, or elsewhere than Windows, nothing is asked
    await w.manager.prepare({ account: codexAccount, cwd })
    w.manager.spawn({ account: codexAccount, cwd })
    const l = rig('linux', { ready: notSetUp })
    await l.manager.prepare({ account: codexAccount, cwd, sandbox: true })
    l.manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(asked).toHaveLength(1)
    expect(w.spawned).toHaveLength(1)
    expect(l.spawned).toHaveLength(1)
  })

  // Task 6 fix round 1: Codex could not be asked (missing, too old for doctor --json, timed out, a report that does not
  // read): its own refusal, which offers no setup, and nothing written for it
  it('a sandboxed win32 Codex start whose readiness could not be asked refuses with windows-check-failed', async () => {
    const cwd = repo()
    const w = rig('win32', { ready: async () => 'check-failed' })
    await expect(w.manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-check-failed codex acc-cx$/)
    expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(false)
    expect(w.spawned).toHaveLength(0)
  })

  // Task 6 fix round 1: a chat chain's roll is prepared here too, and a chat's app-server needs no --no-daemon, so its
  // sandbox is not refused for a codex without it; the layout it reads is the chat respawn's
  it('a chat roll’s preparation does not ask for --no-daemon', async () => {
    const cwd = repo()
    const { manager } = rig('linux', { noDaemon: false })
    await expect(manager.prepare({ account: codexAccount, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: codex-daemon codex$/)
    await manager.prepare({ account: codexAccount, cwd, sandbox: true, chat: true })
    expect(manager.sandboxLayouts.layoutOf(codexAccount.id, cwd, Date.now())).toEqual(await gitLayoutOf(cwd))
  })

  // Readiness is per account, so what a prepare read is kept for the account it was asked for: another account's
  // sandboxed spawn in the same folder is not let through on it
  it('a prepared sandbox is kept for its own account', async () => {
    const cwd = repo()
    const other: Account = { ...codexAccount, id: 'acc-cx2', configDir: 'C:\\Users\\tester\\.codex-accounts\\other' }
    const { manager, spawned } = rig('win32')
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    expect(() => manager.spawn({ account: other, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(spawned).toHaveLength(1)
  })

  // The line a refused roll leaves in the app's own tab (main/index.ts's codex rolling `tell`): output, not input
  it('say puts a line in a live session’s output, and nothing for one that exited or is not here', async () => {
    const cwd = repo()
    const ptys: FakePty[] = []
    const manager = new SessionManager((_f, _a, _o) => { const p = new FakePty(); ptys.push(p); return p }, makeDescriptors('linux', HOME.linux, undefined, daemon(true)),
      100, 20, HOME.linux, undefined, [], { ...BASE.linux }, checksFor('linux'))
    const data: Array<{ sessionId: string; data: string }> = []
    manager.onData = (e) => data.push(e)
    await manager.prepare({ account: codexAccount, cwd })
    const info = manager.spawn({ account: codexAccount, cwd })
    manager.say(info.id, '\r\n[Astera] why\r\n')
    expect(data).toEqual([{ sessionId: info.id, data: '\r\n[Astera] why\r\n' }])
    expect(ptys[0].written).toEqual([])
    manager.say('nobody', 'x')
    ptys[0].emitExit(0)
    manager.say(info.id, 'late')
    expect(data).toHaveLength(1)
  })

  it('a folder outside any repository gets no git entries, and still starts', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'astera-sbx-'))
    dirs.push(cwd)
    const { manager, argv, spawned } = rig('win32')
    await manager.prepare({ account: codexAccount, cwd, sandbox: true })
    manager.spawn({ account: codexAccount, cwd, sandbox: true })
    expect(codexArgs(argv[0])).toEqual(['-c', 'check_for_update_on_startup=false', '--no-daemon', ...(await expected('win32', cwd)).args])
    expect(codexArgs(argv[0]).join(' ')).not.toMatch(/\.git"=|\.git\/|:workspace_roots/)
    expect(spawned[0].env?.GIT_CONFIG_COUNT).toBeUndefined()
  })
})

// The sandbox for Claude (sandbox design §6): Claude's sandbox is its settings file, so a sandboxed Claude session reads
// the sandbox twin of the file it would read anyway (StatusLineManager.ensureSandboxFiles), with npm's cache in TEMP and,
// on Linux, the git excludes srt's placeholders need (Task 2's ruling). On Windows the twin holds the deny rules only.
describe('the sandbox at spawn, for Claude', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'astera-claude-sbx-'))
    dirs.push(d)
    return d
  }
  const HOME = { linux: '/home/t', darwin: '/Users/t', win32: 'C:\\Users\\t' } as const
  const BASE = {
    linux: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    darwin: { PATH: '/usr/bin' },
    win32: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }
  } as const
  const checksFor = (platform: NodeJS.Platform): SpawnChecks => ({ linkLook: null,
    cwd: async () => 'present', gitBash: createGitBashResolver(async () => 'absent'), platform, now: Date.now, syncExists: () => true, log: () => {}
  })
  const rig = async (platform: 'linux' | 'darwin' | 'win32', version: string | null | undefined = '2.1.310', extraEnv: Record<string, string> = {}) => {
    const profileDir = temp()
    const tmpDir = temp()
    const gitHome = temp()
    const statusLine = new StatusLineManager(profileDir, 'node', () => {}, {
      platform,
      execPath: platform === 'win32' ? 'C:/x/electron.exe' : '/opt/astera/astera',
      homeDir: HOME[platform],
      tmpDir
    })
    await statusLine.init()
    const warmed: string[] = []
    const versions = Object.assign(() => version, { warm: async (cli: 'claude' | 'codex') => void warmed.push(cli) })
    const argv: string[][] = []
    const spawned: PtySpawnOptions[] = []
    const manager = new SessionManager(
      (_f, a, opts) => (argv.push(a as string[]), spawned.push(opts), new FakePty()),
      makeDescriptors(platform, HOME[platform]),
      100, 20, HOME[platform],
      (id, acc, o) => statusLine.spawnConfig(id, acc, o),
      [], { ...BASE[platform], ...extraEnv }, checksFor(platform)
    )
    manager.claudeSandbox = claudeSandboxStart({ linkLook: null,
      platform, profileDir, homeDir: gitHome, env: {}, tmpDir, files: statusLine, version: versions, uid: 1000,
      runGit: async () => null, log: () => {}
    })
    return { manager, argv, spawned, statusLine, profileDir, tmpDir, gitHome, warmed }
  }
  /** The `--settings` file a session was started with. */
  const settingsOf = (a: string[]): string => a[a.indexOf('--settings') + 1]
  /** The builder's settings for a session of the rig's profile, with its app key denied (sandbox follow-ups, item 1) and the
   *  profile folder itself kept read-only (Task E). */
  const builder = (platform: 'linux' | 'darwin' | 'win32', r: { tmpDir: string; profileDir: string }, layout: GitLayout | null = null) => {
    const env = { ...BASE[platform] }
    const denied = [...sensitiveLocations(platform, env, HOME[platform]), ...credentialStoreDenies(platform, env, HOME[platform]), ...appKeyDenies(appKeyPath(r.profileDir))]
    const tmpDir = r.tmpDir
    return claudeSandboxSettings({ platform, denied, readOnly: profileReadOnly(r.profileDir), npmCache: npmCacheOf(tmpDir), layout })
  }
  /** A repository's top in a fresh temp folder: a `.git` folder is all gitLayoutOf needs. */
  const repoIn = (): string => {
    const top = temp()
    mkdirSync(path.join(top, '.git'))
    return top
  }

  // Task K (the person's Q2): a Task's check of a sandboxed Claude worker on macOS and Linux runs under srt with the
  // settings the session's twin holds (srtCheck.ts), through Astera's runner, from the session's environment after the
  // hiding; where srt cannot run, or Ubuntu confines bubblewrap, or on Windows (no sandbox), it is refused (E5)
  it("starts a sandboxed Claude worker's check under srt with its twin's settings, through Astera's runner", async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = await rig(platform, '2.1.310', { SECRET_TOKEN: 's' })
      r.manager.hiding = { get: () => ({ remove: ['SECRET_TOKEN'], set: {} }), damaged: () => false }
      const payloads: SrtCheckPayload[] = []
      r.manager.checkRunner = {
        missing: async () => null,
        launch: (p) => (payloads.push(p), { file: '/opt/astera/astera', args: ['/opt/astera/sandbox-check.js', JSON.stringify(p)], env: { ELECTRON_RUN_AS_NODE: '1' } })
      }
      const cwd = repoIn()
      const launch = await r.manager.checkLaunch({ account, cwd, command: 'npm run test' })
      const layout = await gitLayoutOf(cwd)
      expect(payloads, platform).toEqual([{ config: srtConfigOf(builder(platform, r, layout).sandbox!, { cwd, layout }), cwd, command: 'npm run test' }])
      expect(launch.file).toBe('/opt/astera/astera')
      expect(launch.runner).toBe(true)
      expect(launch.env, platform).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', npm_config_cache: npmCacheOf(r.tmpDir) })
      expect(launch.env, platform).not.toHaveProperty('SECRET_TOKEN')
    }
  })

  it('refuses a Claude check where srt cannot run, where Ubuntu confines bubblewrap, on Windows, and with no runner', async () => {
    const never = (): never => {
      throw new Error('not launched')
    }
    const r = await rig('linux')
    r.manager.checkRunner = { missing: async () => 'ripgrep (rg) not found', launch: never }
    await expect(r.manager.checkLaunch({ account, cwd: repoIn(), command: 'x' })).rejects.toThrow('SANDBOX_UNAVAILABLE: runtime-missing claude')
    r.manager.checkRunner = { missing: async () => null, launch: never }
    r.manager.sandboxWarn = { claudeUsernsRestricted: () => true, warn: () => {} }
    await expect(r.manager.checkLaunch({ account, cwd: repoIn(), command: 'x' })).rejects.toThrow('SANDBOX_UNAVAILABLE: userns-restricted claude')
    const w = await rig('win32')
    await expect(w.manager.checkLaunch({ account, cwd: repoIn(), command: 'x' })).rejects.toThrow('SANDBOX_UNAVAILABLE: no-sandbox claude')
    // Fix round 2: a process without the runner says so, which running the checks again will not change
    const none = await rig('darwin')
    await expect(none.manager.checkLaunch({ account, cwd: repoIn(), command: 'x' })).rejects.toThrow('SANDBOX_UNAVAILABLE: no-check-runner')
  })

  // Task E fix round 2: where Ubuntu's AppArmor profile confines bubblewrap (asked once per process by the wiring), a
  // sandboxed Claude session on Linux starts as today and its sink is told why its shell will fail; not when the check
  // says no, not on another OS, and not for a session outside the sandbox
  it('tells a sandboxed Claude start on Linux where bubblewrap is confined, and no other', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const restricted of [true, false]) {
        const r = await rig(platform)
        const told: string[][] = []
        let asked = 0
        r.manager.sandboxWarn = { claudeUsernsRestricted: () => (asked++, restricted), warn: (_id, ws) => void told.push([...ws]) }
        const cwd = temp()
        await r.manager.prepare({ account, cwd, sandbox: true })
        r.manager.spawn({ account, cwd, sandbox: true })
        await r.manager.prepare({ account, cwd })
        r.manager.spawn({ account, cwd })
        expect(r.argv, `${platform} ${restricted}`).toHaveLength(2)
        expect(told, `${platform} ${restricted}`).toEqual(platform === 'linux' && restricted ? [['claudeUserns']] : [])
        expect(asked, `${platform} ${restricted}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('a sandboxed Claude session on linux gets the sandbox variant', async () => {
    const r = await rig('linux')
    mkdirSync(path.join(r.gitHome, '.config', 'git'), { recursive: true })
    writeFileSync(path.join(r.gitHome, '.config', 'git', 'ignore'), '*.secret\n')
    const cwd = temp()
    await r.manager.prepare({ account, cwd, sandbox: true })
    expect(r.warmed).toEqual(['claude'])
    const info = r.manager.spawn({ account, cwd, sandbox: true, bypassPermissions: true })
    const file = settingsOf(r.argv[0])
    // Its scope's twin: outside a repository, and from the session's own environment
    expect(file).toBe(r.statusLine.spawnConfig('x', account, { sandbox: { layout: null, env: { ...BASE.linux } } }).settingsFile)
    expect(path.basename(file)).toBe(path.basename(r.statusLine.spawnConfig('x', account).settingsFile).replace(/\.json$/, '-sandbox.json'))
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    expect(settings.sandbox).toEqual(builder('linux', r).sandbox)
    expect(settings.permissions.deny).toContain('Read(//home/t/.ssh/**)')
    expect(settings.permissions.deny).toContain('Read(//run/user/1000/bus)')
    // Claude's own sandbox stands where Codex's -a never does: the bypass is the person's choice, as before
    expect(r.argv[0]).toContain('--dangerously-skip-permissions')
    // npm's cache is made first, and the session's git reads the excludes file Astera wrote
    const env = r.spawned[0].env ?? {}
    expect(env.npm_config_cache).toBe(npmCacheOf(r.tmpDir))
    expect(existsSync(npmCacheOf(r.tmpDir))).toBe(true)
    const excludes = gitExcludesFileOf(r.profileDir, 1000)
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes })
    expect(readFileSync(excludes, 'utf8')).toBe(gitExcludesText('*.secret\n'))
    // Marked in the info and the note, which a Host handing the session back and a roll read
    expect(info.sandboxed).toBe(true)
    expect(info.sandboxKind).toBe('sandbox')
    expect(r.spawned[0].meta?.restore).toMatchObject({ sandboxed: true, sandboxKind: 'sandbox' })
    expect(sessionInfoFromNote({ kind: 'session', id: info.id, restore: r.spawned[0].meta!.restore! })).toMatchObject({ sandboxed: true, sandboxKind: 'sandbox' })
    // Unsandboxed, the same session reads today's file, with nothing of the sandbox's environment
    await r.manager.prepare({ account, cwd })
    const plain = r.manager.spawn({ account, cwd, bypassPermissions: true })
    expect(settingsOf(r.argv[1])).toBe(r.statusLine.spawnConfig('x', account).settingsFile)
    expect(r.spawned[1].env?.npm_config_cache).toBeUndefined()
    expect(r.spawned[1].env?.GIT_CONFIG_COUNT).toBeUndefined()
    expect(plain).not.toHaveProperty('sandboxed')
  })

  // Final fix pass (C2): the Host's socket is not granted to the sandbox and no address is planted; `astera` reaches the
  // Host through excludedCommands, outside the sandbox, and a person's own ASTERA_HOST stays theirs
  it('on macOS it gets the variant with the keychains denied, no socket granted and no git excludes', async () => {
    const r = await rig('darwin')
    const cwd = temp()
    await r.manager.prepare({ account, cwd, sandbox: true })
    r.manager.spawn({ account, cwd, sandbox: true })
    const settings = JSON.parse(readFileSync(settingsOf(r.argv[0]), 'utf8'))
    expect(settings.permissions.deny).toContain('Read(//Users/t/Library/Keychains/**)')
    expect(settings.sandbox).toEqual(builder('darwin', r).sandbox)
    expect(settings.sandbox).not.toHaveProperty('network')
    expect(r.spawned[0].env?.npm_config_cache).toBe(npmCacheOf(r.tmpDir))
    expect(r.spawned[0].env?.GIT_CONFIG_COUNT).toBeUndefined()
    expect(Object.keys(r.spawned[0].env ?? {}).filter((k) => /^ASTERA_(SANDBOX_)?HOST$/.test(k))).toEqual([])
    const own = await rig('darwin', '2.1.310', { ASTERA_HOST: '/Users/t/hosts/mine.sock' })
    await own.manager.prepare({ account, cwd, sandbox: true })
    own.manager.spawn({ account, cwd, sandbox: true })
    expect(own.spawned[0].env?.ASTERA_HOST).toBe('/Users/t/hosts/mine.sock')
    expect(JSON.parse(readFileSync(settingsOf(own.argv[0]), 'utf8')).sandbox).not.toHaveProperty('network')
  })

  // Final fix pass (C1): in a repository the twin keeps every git file that decides what git runs from being written, the
  // missing ones made first, on macOS and Linux; a session in a folder nobody prepared for this account is refused
  it('in a repository its twin keeps the git files from being written, made first, and a folder not prepared refuses', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = await rig(platform)
      const cwd = repoIn()
      await r.manager.prepare({ account, cwd, sandbox: true })
      r.manager.spawn({ account, cwd, sandbox: true })
      const layout = await gitLayoutOf(cwd)
      const settings = JSON.parse(readFileSync(settingsOf(r.argv[0]), 'utf8'))
      expect(settings.sandbox).toEqual(builder(platform, r, layout).sandbox)
      // The git files, and the profile folder after them (Task E)
      expect(settings.sandbox.filesystem.denyWrite).toEqual([
        ...layout!.gitFiles, `${layout!.commonDir}/hooks`, `${layout!.commonDir}/config`, ...layout!.worktreeConfigs, r.profileDir.replace(/\\/g, '/')
      ])
      expect(readFileSync(path.join(cwd, '.git', 'commondir'), 'utf8')).toBe('.\n')
      expect(existsSync(path.join(cwd, '.git', 'modules'))).toBe(true)
      expect(existsSync(path.join(cwd, '.git', 'config.worktree'))).toBe(true)
      expect(() => r.manager.spawn({ account, cwd: repoIn(), sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
      expect(() => r.manager.spawn({ account: { ...account, id: 'acc-other' }, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    }
    // Windows: deny rules only, whatever the folder, and nothing is made in its git directory
    const win = await rig('win32')
    const cwd = repoIn()
    await win.manager.prepare({ account, cwd, sandbox: true })
    win.manager.spawn({ account, cwd, sandbox: true })
    expect(JSON.parse(readFileSync(settingsOf(win.argv[0]), 'utf8'))).not.toHaveProperty('sandbox')
    expect(existsSync(path.join(cwd, '.git', 'commondir'))).toBe(false)
  })

  it('on win32 it gets the deny-only variant', async () => {
    const r = await rig('win32')
    const cwd = temp()
    await r.manager.prepare({ account, cwd, sandbox: true })
    const info = r.manager.spawn({ account, cwd, sandbox: true })
    const settings = JSON.parse(readFileSync(settingsOf(r.argv[0]), 'utf8'))
    expect(settings).not.toHaveProperty('sandbox')
    expect(settings.permissions.deny).toEqual(builder('win32', r).permissions.deny)
    expect(settings.permissions.deny).toContain('Read(//c/Users/t/.ssh/**)')
    expect(r.spawned[0].env?.GIT_CONFIG_COUNT).toBeUndefined()
    expect(existsSync(path.join(r.profileDir, 'sandbox'))).toBe(false)
    expect(info.sandboxed).toBe(true)
    // Task 8 fix round 1: deny rules only, and the info and the note say so, so the tab does not claim a sandbox
    expect(info.sandboxKind).toBe('deny-only')
    expect(r.spawned[0].meta?.restore).toMatchObject({ sandboxed: true, sandboxKind: 'deny-only' })
    expect(sessionInfoFromNote({ kind: 'session', id: info.id, restore: r.spawned[0].meta!.restore! })).toMatchObject({ sandboxed: true, sandboxKind: 'deny-only' })
    // Task 7 fix round 1: Claude has no shell sandbox on Windows, so npm keeps its own cache: nothing planted or made
    expect(r.spawned[0].env).not.toHaveProperty('npm_config_cache')
    expect(existsSync(npmCacheOf(r.tmpDir))).toBe(false)
  })

  it('a Claude older than 2.1.306 refuses a sandboxed start', async () => {
    const r = await rig('linux', '2.1.305')
    const cwd = temp()
    await expect(r.manager.prepare({ account, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: cli-too-old claude 2\.1\.305 2\.1\.306$/)
    // Refused before anything is written for it, and a spawn nobody prepared is refused the same way
    expect(existsSync(r.statusLine.spawnConfig('x', account).settingsFile.replace(/\.json$/, '-sandbox.json'))).toBe(false)
    expect(() => r.manager.spawn({ account, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: cli-too-old claude 2\.1\.305 2\.1\.306$/)
    expect(r.spawned).toHaveLength(0)
    // The same Claude starts outside the sandbox as before
    await r.manager.prepare({ account, cwd })
    r.manager.spawn({ account, cwd })
    expect(r.spawned).toHaveLength(1)
  })

  it('a sandboxed Claude spawn whose sandbox settings were never written refuses with not-prepared', async () => {
    const r = await rig('linux')
    const cwd = temp()
    expect(() => r.manager.spawn({ account, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    // A manager with no Claude sandbox to start refuses too, rather than start it outside the sandbox
    r.manager.claudeSandbox = undefined
    await expect(r.manager.prepare({ account, cwd, sandbox: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    expect(() => r.manager.spawn({ account, cwd, sandbox: true })).toThrow(/^SANDBOX_UNAVAILABLE: not-prepared$/)
    expect(r.spawned).toHaveLength(0)
  })

  it('Enforce and the sandbox together: one settings file with both', async () => {
    const r = await rig('linux')
    const cwd = temp()
    r.manager.capabilities = {
      get: () => ({ context: { kind: 'implicit', accounts: [account.id], policyMode: 'enforce', executionMode: 'managed' }, args: [], env: {}, given: [], gatewayGrant: [], skipped: [] }),
      refresh: async () => {}
    }
    r.manager.enforceHooks = () => r.statusLine.ensureEnforceFiles()
    r.manager.enforce = { args: () => null, blocker: () => null }
    await r.manager.prepare({ account, cwd, sandbox: true })
    const info = r.manager.spawn({ account, cwd, sandbox: true })
    const settings = JSON.parse(readFileSync(settingsOf(r.argv[0]), 'utf8'))
    expect(settings.hooks.PreToolUse.some((e: { matcher?: string }) => e.matcher === '*')).toBe(true)
    expect(settings.disableAllHooks).toBe(false)
    expect(settings.sandbox).toEqual(builder('linux', r).sandbox)
    expect(r.spawned[0].meta?.restore).toMatchObject({ observed: true, enforced: true, sandboxed: true })
    expect(info.sandboxed).toBe(true)
  })
})
