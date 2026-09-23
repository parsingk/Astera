import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import type { Account } from '../types'
import { StatusLineManager } from './statusline'

const account: Account = {
  id: 'a1', label: 't', configDir: path.join(os.tmpdir(), 'astera-none-config'), color: '#fff',
  createdAt: '2026-07-23T00:00:00Z'
}

describe('StatusLineManager 훅 주입', () => {
  let dir: string
  let mgr: StatusLineManager

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-'))
    mgr = new StatusLineManager(dir)
    await mgr.init()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('init은 훅 캡처 스크립트·hooks 설정 파일·hook-events 디렉터리를 만든다', async () => {
    const capture = await fs.readFile(path.join(dir, 'astera-hook-capture.cjs'), 'utf8')
    expect(capture).toContain('ASTERA_HOOK_OUT')
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    expect(settings.statusLine.type).toBe('command')
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect((await fs.stat(mgr.hookEventsDir)).isDirectory()).toBe(true)
  })

  // PreToolUse로 캡처한 대기 내용을 확정 무효화하는 짝이다 — 없으면 서브에이전트가 실행한 도구가
  // Stop 전까지 "대기 중"으로 남는다(사유는 SlackNotifier.clearPendingTool 주석).
  it('PostToolUse 훅도 PreToolUse와 같은 matcher로 등록한다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    expect(settings.hooks.PostToolUse[0].matcher).toBe(settings.hooks.PreToolUse[0].matcher)
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  it('spawnConfig: toolHooks=true면 도구 캡처까지 든 설정 파일', () => {
    const c = mgr.spawnConfig('sess-1', account, { toolHooks: true })
    expect(c.settingsFile).toContain('astera-hooks-settings.json')
    expect(c.hookOutPath?.replace(/\\/g, '/')).toContain('hook-events/sess-1.jsonl')
  })

  // 데스크톱 알림은 어떤 세션에서든 온다 — 그 세션에 Slack 을 켜 뒀는지, 롤링을 걸어 뒀는지와
  // 무관하다. 그러려면 Stop·Notification 훅이 모든 세션에 들어가야 하고, 그 훅이 쓸
  // ASTERA_HOOK_OUT 경로도 함께 있어야 한다. 이 경로가 없던 동안 훅은 심어져도 쓸 곳이 없었고,
  // 알림 기능 전체가 보통 세션에서 한 번도 동작하지 않았다.
  it('spawnConfig: 도구 캡처가 없어도 세션별 hookOutPath 는 항상 준다', () => {
    const c = mgr.spawnConfig('sess-1', account)
    expect(c.settingsFile).toContain('astera-statusline-settings.json')
    expect(c.hookOutPath?.replace(/\\/g, '/')).toContain('hook-events/sess-1.jsonl')
  })

  it('기본 설정 파일은 Notification 훅을 갖는다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.statusLine.command).toContain('astera-statusline-capture.cjs')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  // 원래 회귀 가드가 지키려던 것은 "훅이 없다"가 아니라 "읽는 사람이 없는 훅에 프로세스를 쓰지
  // 않는다"였다. AskUserQuestion 짝은 이제 모든 세션이 읽는다 — 대화 뷰가 그 tool_input 으로 질문
  // 카드를 그린다(main/pendingPrompt.ts). 질문은 몇 분에 한 번이라 Stop 과 같은 비용이다. 나머지
  // 도구(Bash·Write·Edit…)는 호출마다 프로세스를 띄우므로 여전히 Slack·롤링 세션의 파일에만 있다.
  it('기본 설정 파일의 도구 훅 짝은 AskUserQuestion 만 본다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion')
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect(settings.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion')
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  it('도구 캡처 파일의 matcher 는 기본 파일의 것을 포함하는 상위 집합이다', async () => {
    const base = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    const full = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    const fullTools: string[] = full.hooks.PreToolUse[0].matcher.split('|')
    expect(fullTools).toContain(base.hooks.PreToolUse[0].matcher)
    expect(fullTools).toContain('Bash')
  })

  // Stop left the guard above deliberately, and the rule that guard states is why it could: it asks
  // that no process be spent on a hook nobody reads, and main/attention.ts reads this one for every
  // session. It is the only event an ordinary session ever gets that can end a `waiting` value —
  // PostToolUse fires only when a call actually runs, so answering "no" to an approval produces
  // none, and without this the conversation view's banner and its locked composer never come back.
  it('the default settings file carries Stop, which is how a session stops waiting', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  // 반대쪽 절반 — Slack 세션은 Stop 을 받아야 한다. 턴 요약이 그 훅에서 온다.
  it('도구 훅 설정 파일은 Stop 도 갖는다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  // `astera sessions list` 의 state 가 읽는 턴의 시작과 오류로 끝난 턴(core/hooks/sessionState.ts).
  // 둘 다 async — 프롬프트마다 캡처 프로세스를 기다리지 않는다. 두 설정 파일 모두에 든다.
  it.each(['astera-statusline-settings.json', 'astera-hooks-settings.json'])(
    '%s 는 UserPromptSubmit 과 StopFailure 를 async 로 캡처한다',
    async (file) => {
      const settings = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
      for (const event of ['UserPromptSubmit', 'StopFailure']) {
        expect(settings.hooks[event], event).toHaveLength(1)
        expect(settings.hooks[event][0].matcher, event).toBeUndefined()
        expect(settings.hooks[event][0].hooks, event).toEqual([
          { type: 'command', command: settings.hooks.Stop[0].hooks[0].command, async: true }
        ])
      }
      // 이미 있던 훅은 바꾸지 않는다 — 동기 그대로다.
      expect(settings.hooks.Stop[0].hooks[0].async).toBeUndefined()
    }
  )

  /** Runs the capture script the way Claude Code does: payload on stdin, ASTERA_HOOK_OUT set. The
   *  payload is written only after `stdinDelayMs`, so a stamp taken before stdin is read is earlier
   *  than the write. Returns when it was written and the file's lines. */
  const capture = async (
    payload: string,
    stdinDelayMs = 0,
    env: Record<string, string> = {}
  ): Promise<{ writtenAt: number; lines: string[] }> => {
    const out = path.join(dir, 'capture-out.jsonl')
    const child = spawn(process.execPath, [path.join(dir, 'astera-hook-capture.cjs')], {
      env: { ...process.env, ASTERA_HOOK_OUT: out, ...env },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const closed = new Promise((r) => child.on('close', r))
    await new Promise((r) => child.on('spawn', r))
    await new Promise((r) => setTimeout(r, stdinDelayMs))
    const writtenAt = Date.now()
    child.stdin.end(payload)
    await closed
    return { writtenAt, lines: (await fs.readFile(out, 'utf8')).split('\n').filter((l) => l !== '') }
  }

  // UserPromptSubmit·StopFailure 는 async 라 캡처가 붙는 순서가 뒤집힐 수 있다. Claude Code 는 훅을
  // 이벤트 순서대로 띄우니, 캡처가 시작한 시각이 이벤트 순서다 — stdin 을 읽기 전에 잰다.
  it('캡처는 stdin 을 읽기 전에 잰 시각을 astera_at 으로 싣고, 나머지는 그대로 둔다', async () => {
    const { writtenAt, lines } = await capture('{"hook_event_name":"Stop","session_id":"s",\n"n":12345678901234567890}', 300)
    expect(lines).toHaveLength(1)
    const p = JSON.parse(lines[0])
    expect(typeof p.astera_at).toBe('number')
    expect(p.astera_at).toBeLessThan(writtenAt)
    expect(p.hook_event_name).toBe('Stop')
    expect(p.session_id).toBe('s')
    // 다시 직렬화하지 않는다 — 큰 정수도 적힌 그대로다.
    expect(lines[0]).toContain('"n":12345678901234567890')
  })

  // 시각은 스크립트의 첫 문장이 아니라 프로세스가 시작한 때다(performance.timeOrigin) — node 가 뜨는
  // 데 드는 시간과 그 흔들림이 빠진다. 스크립트보다 먼저 도는 --require 가 300ms 를 붙잡아도 시각은
  // 그 앞이어야 한다. 소수점 아래도 그대로 싣는다.
  it('시각은 프로세스 시작 시각이라 스크립트 앞의 지연이 들어가지 않는다', async () => {
    // The preload notes when it began, inside the capture's own process, and then holds it. The stamp
    // must not be later than that note: no wall-clock bound that a slow machine could overrun.
    const spin = path.join(dir, 'spin.cjs')
    const spinAt = path.join(dir, 'spin-at.txt')
    await fs.writeFile(
      spin,
      `const s = Date.now(); require('fs').writeFileSync(${JSON.stringify(spinAt)}, String(s)); while (Date.now() < s + 300) {}\n`,
      'utf8'
    )
    const { lines } = await capture('{"hook_event_name":"Stop"}', 0, {
      NODE_OPTIONS: `--require "${spin.replace(/\\/g, '/')}"`
    })
    const at = JSON.parse(lines[0]).astera_at
    // +1: the preload's Date.now() is a whole millisecond, the stamp can carry a fraction of the same one.
    expect(at).toBeLessThan(Number(await fs.readFile(spinAt, 'utf8')) + 1)
    expect(lines[0]).toMatch(/^\{"astera_at":\d+(\.\d+)?,"hook_event_name":"Stop"\}$/)
  })

  // 떠 있는 세션의 훅은 경로로 이 스크립트를 부른다. init 이 제자리에서 덮어쓰면 그 사이에 뜬 캡처가
  // 반쯤 쓴 파일을 읽는다 — 임시 파일에 다 쓴 뒤 바꿔 끼운다. 바꿔 끼웠으면 파일이 새 것이다(ino).
  it.each(['astera-hook-capture.cjs', 'astera-statusline-capture.cjs'])(
    '%s 는 제자리에 덮어쓰지 않고 다 쓴 파일로 바꿔 끼운다',
    async (name) => {
      const file = path.join(dir, name)
      await fs.writeFile(file, '// an older build\n', 'utf8')
      const first = (await fs.stat(file, { bigint: true })).ino
      await mgr.init()
      expect((await fs.stat(file, { bigint: true })).ino).not.toBe(first)
      expect(await fs.readFile(file, 'utf8')).toContain('process.stdin')
      expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([])
    }
  )

  // 대부분의 실행은 같은 바이트를 쓴다. 같으면 아예 쓰지 않는다 — 떠 있는 훅이 읽는 중인 파일을
  // 건드릴 일이 흔한 경우에는 없다.
  it.each(['astera-hook-capture.cjs', 'astera-statusline-capture.cjs'])(
    '%s 의 내용이 같으면 init 은 쓰지 않는다',
    async (name) => {
      const file = path.join(dir, name)
      const before = await fs.stat(file, { bigint: true })
      await mgr.init()
      const after = await fs.stat(file, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeNs).toBe(before.mtimeNs)
    }
  )

  // Windows 에서 훅이 이 스크립트를 여는 순간의 rename 은 EPERM 으로 실패한다(검토가 잰 값 5~8%).
  // 잠깐의 핸들이라 몇 번 다시 해 보면 넘어간다.
  it('rename 이 EPERM 으로 몇 번 실패해도 다시 해서 바꿔 끼운다', async () => {
    const file = path.join(dir, 'astera-hook-capture.cjs')
    await fs.writeFile(file, '// an older build\n', 'utf8')
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename')
    rename.mockRejectedValueOnce(eperm).mockRejectedValueOnce(eperm).mockRejectedValueOnce(eperm)
    try {
      await expect(mgr.init()).resolves.toBeUndefined()
    } finally {
      rename.mockRestore()
    }
    expect(await fs.readFile(file, 'utf8')).toContain('astera_at')
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  // 끝내 안 되면 예전처럼 제자리에 쓴다 — 드물게 반쯤 읽기가 날 수 있어도 앱 시작을 막지는 않는다.
  // 전에는 init 이 거부했고, createCore 가 거부해 창이 뜨지 않았다(core/scheduler/config.ts 의 같은 경로).
  it('rename 이 끝내 실패하면 제자리에 쓰고 init 은 성공한다', async () => {
    const file = path.join(dir, 'astera-hook-capture.cjs')
    await fs.writeFile(file, '// an older build\n', 'utf8')
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(eperm)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(mgr.init()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      rename.mockRestore()
      warn.mockRestore()
    }
    expect(await fs.readFile(file, 'utf8')).toContain('astera_at')
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('객체가 아닌 페이로드는 예전처럼 한 줄로 그대로 붙는다', async () => {
    const { lines } = await capture('not json\nsecond')
    expect(lines).toEqual(['not json second'])
  })

  it('빈 객체에도 시각을 싣는다', async () => {
    const { lines } = await capture('{ }')
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['astera_at'])
  })
})

// What the app reads a session's transcript path out of. The folder used to be wiped at init, on the
// grounds that a restart killed every pty; the Host made that false, and the wipe then cost every
// surviving session its path until it next wrote a statusline.
describe('StatusLineManager statusline payloads', () => {
  let dir: string
  let mgr: StatusLineManager

  const writePayload = async (sessionId: string): Promise<void> => {
    await fs.writeFile(
      path.join(dir, 'statusline', `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, transcript_path: `/t/${sessionId}.jsonl` }),
      'utf8'
    )
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slp-'))
    mgr = new StatusLineManager(dir)
    await mgr.init()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('init keeps a payload written by a previous run — a session can outlive the app', async () => {
    await writePayload('survivor')
    await new StatusLineManager(dir).init()
    expect(await mgr.read('survivor')).toEqual({
      session_id: 'survivor',
      transcript_path: '/t/survivor.jsonl'
    })
  })

  it('pruneExcept drops the payloads of sessions that are gone and keeps the rest', async () => {
    await writePayload('alive')
    await writePayload('gone')
    await mgr.pruneExcept(new Set(['alive']))
    expect(await mgr.read('alive')).not.toBeNull()
    expect(await mgr.read('gone')).toBeNull()
  })

  it('pruneExcept leaves anything that is not a payload alone', async () => {
    const stray = path.join(dir, 'statusline', 'notes.txt')
    await fs.writeFile(stray, 'keep me', 'utf8')
    await mgr.pruneExcept(new Set())
    expect(await fs.readFile(stray, 'utf8')).toBe('keep me')
  })

  it('pruneExcept does not throw when there is no folder yet', async () => {
    await fs.rm(path.join(dir, 'statusline'), { recursive: true, force: true })
    await expect(mgr.pruneExcept(new Set(['alive']))).resolves.toBeUndefined()
  })
})
