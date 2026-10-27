import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, promises as fs, watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import type { Account } from '../types'
import { StatusLineManager, captureCommand, enforceCommand, enforceInterpreter, ENFORCE_HOOK_FILE } from './statusline'
import enforceHookSource from 'virtual:astera-enforce-hook'
import { codexEnforceArgs } from './codexEnforce'
import { dirIdentity } from '../files/watchedDir'
import { createAttentionState } from './attention'
import { hookEventState, latestEventLine } from '../hooks/sessionState'
import { resolveAction } from '../audit/resolve'
import { claudeSandboxSettings } from '../sandbox/claudeSettings'
import { credentialStoreDenies, sensitiveLocations } from '../sandbox/locations'
import { npmCacheOf } from '../sandbox/codexProfile'
import { hostAddress } from '../publicContract'
import { HOST_PROTOCOL } from '../host/protocol'

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

  // The context is only worth anything if it is in every session and in the one place Claude reads it:
  // a synchronous SessionStart hook whose stdout is the hook JSON (sessionContext.ts).
  it('SessionStart 훅이 두 설정 파일 모두에 있고 컨텍스트 스크립트를 가리킨다', async () => {
    for (const f of ['astera-statusline-settings.json', 'astera-hooks-settings.json']) {
      const settings = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
      const hook = settings.hooks.SessionStart[0].hooks[0]
      expect(hook.command).toContain('astera-session-context.cjs')
      expect(hook.async).toBeUndefined()
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    }
    expect(await fs.readFile(path.join(dir, 'astera-session-context.cjs'), 'utf8')).toContain('SessionStart')
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
  // 카드를 그린다(core/sessions/pendingPrompt.ts). 질문은 몇 분에 한 번이라 Stop 과 같은 비용이다. 나머지
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
  // that no process be spent on a hook nobody reads, and core/sessions/attention.ts reads this one for every
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

describe('StatusLineManager.ensureFiles (the Host half)', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-ensure-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  // Design §2.2: the Host must never erase the hook events of the sessions it is running.
  it('never removes the hook events folder or anything in it', async () => {
    const mgr = new StatusLineManager(dir)
    const events = path.join(mgr.hookEventsDir, 'ses_live.jsonl')
    await fs.mkdir(mgr.hookEventsDir, { recursive: true })
    await fs.writeFile(events, '{"hook_event_name":"Stop"}\n')
    await mgr.ensureFiles()
    expect(await fs.readFile(events, 'utf8')).toBe('{"hook_event_name":"Stop"}\n')
  })

  it('writes both scripts and both settings files', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.ensureFiles()
    for (const f of ['astera-statusline-capture.cjs', 'astera-hook-capture.cjs', 'astera-statusline-settings.json', 'astera-hooks-settings.json'])
      await expect(fs.stat(path.join(dir, f))).resolves.toBeTruthy()
  })

  // Two processes write these files from S2 on; identical content is left alone (writeScript's rule).
  it('does not rewrite a settings file whose content is already right', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.ensureFiles()
    const spy = vi.spyOn(fs, 'writeFile')
    try {
      await mgr.ensureFiles()
      expect(spy.mock.calls.filter(([p]) => String(p).endsWith('settings.json'))).toEqual([])
    } finally { spy.mockRestore() }
  })

  // A Host-only spawn on a fresh profile (the app's startupCleanup never ran): the capture scripts
  // write into these folders with the error swallowed, so without them the output is lost silently.
  it('creates the statusline output folder and the hook events folder when they are missing', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.ensureFiles()
    expect((await fs.stat(mgr.hookEventsDir)).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dir, 'statusline'))).isDirectory()).toBe(true)
  })

  it('keeps what the statusline output folder already holds', async () => {
    const mgr = new StatusLineManager(dir)
    const payload = path.join(dir, 'statusline', 'ses_live.json')
    await fs.mkdir(path.dirname(payload), { recursive: true })
    await fs.writeFile(payload, '{}')
    await mgr.ensureFiles()
    expect(await fs.readFile(payload, 'utf8')).toBe('{}')
  })

  // A Host that outlives the app holds a watch on this folder. Removing the folder under that watch
  // left it pending delete on win32, the mkdir after it did nothing, and the folder was gone for the
  // whole app session once the watch let go: every hook event of it was dropped (watchedDir.ts).
  it('startupCleanup empties the hook events folder in place, under a watch held on it', async () => {
    const mgr = new StatusLineManager(dir)
    await fs.mkdir(mgr.hookEventsDir, { recursive: true })
    await fs.writeFile(path.join(mgr.hookEventsDir, 'old.jsonl'), 'x\n')
    await fs.writeFile(path.join(mgr.hookEventsDir, 'older.jsonl'), 'y\n')
    const before = dirIdentity(mgr.hookEventsDir)
    const held = watch(mgr.hookEventsDir, () => {})
    held.on('error', () => {})
    try {
      await mgr.startupCleanup()
      // The same folder, readable, and empty.
      expect(dirIdentity(mgr.hookEventsDir)).toBe(before)
      expect(await fs.readdir(mgr.hookEventsDir)).toEqual([])
    } finally {
      held.close()
    }
  })

  it('startupCleanup makes the hook events folder when it is missing', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.startupCleanup()
    expect(dirIdentity(mgr.hookEventsDir)).not.toBeNull()
    expect(await fs.readdir(mgr.hookEventsDir)).toEqual([])
  })

  it('startupCleanup empties the hook events folder, as init always has', async () => {
    const mgr = new StatusLineManager(dir)
    await fs.mkdir(mgr.hookEventsDir, { recursive: true })
    await fs.writeFile(path.join(mgr.hookEventsDir, 'old.jsonl'), 'x\n')
    await mgr.startupCleanup()
    expect(await fs.readdir(mgr.hookEventsDir)).toEqual([])
  })
})

// Claude Code hands a hook's command to Git Bash, or to PowerShell when it finds no Git Bash. The old
// `"node" "script"` was a ParserError in PowerShell, and a bare `node` was nothing on a PC without
// Node.js; the line has to read the same in both, under whatever node it is given.
describe('captureCommand', () => {
  const W = (...parts: string[]): string => parts.join('\\')
  const script = W('C:', 'Users', 'a b', 'AppData', 'Roaming', 'astera', 'astera-hook-capture.cjs')

  it('keeps the quoted form, byte for byte, for a path that is not a Windows one', () => {
    expect(captureCommand('/usr/local/bin/node', '/Users/a/Library/Application Support/astera/x.cjs')).toBe(
      '"/usr/local/bin/node" "/Users/a/Library/Application Support/astera/x.cjs"'
    )
    expect(captureCommand('node', '/home/a/.config/astera/x.cjs')).toBe('"node" "/home/a/.config/astera/x.cjs"')
  })

  it('leaves a bare node bare and single-quotes the script', () => {
    expect(captureCommand('node', script)).toBe("node 'C:/Users/a b/AppData/Roaming/astera/astera-hook-capture.cjs'")
  })

  it('keeps the drive letter of a node path outside its quotes', () => {
    const exe = W('C:', 'Users', 'a b', 'AppData', 'Local', 'astera', 'host-runtime', 'node-24.15.0-astera-host', 'astera-host.exe')
    expect(captureCommand(exe, script)).toBe(
      "C:'/Users/a b/AppData/Local/astera/host-runtime/node-24.15.0-astera-host/astera-host.exe' " +
        "'C:/Users/a b/AppData/Roaming/astera/astera-hook-capture.cjs'"
    )
  })

  it("double-quotes a path with a ' in it, and falls back to the quoted form when $ comes with it", () => {
    const exe = W('C:', "O'Brien", 'node.exe')
    expect(captureCommand(exe, W('C:', "O'Brien", 'x.cjs'))).toBe(`C:"/O'Brien/node.exe" "C:/O'Brien/x.cjs"`)
    expect(captureCommand('node', W('C:', "O'Brien$x", 'x.cjs'))).toBe(`"node" "C:/O'Brien$x/x.cjs"`)
  })

  it('quotes a UNC script for both shells too', () => {
    expect(captureCommand('node', W('', '', 'server', 'share', 'astera', 'x.cjs'))).toBe("node '//server/share/astera/x.cjs'")
  })
})

describe('StatusLineManager.useNode', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-node-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  const commands = async (file: string): Promise<string[]> => {
    const s = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
    return [s.statusLine.command, s.hooks.SessionStart[0].hooks[0].command, s.hooks.Stop[0].hooks[0].command]
  }

  it('rewrites both settings files with the new node', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    const node = 'C:\\rt\\astera-host.exe'
    await mgr.useNode(node)
    const scripts = ['astera-statusline-capture.cjs', 'astera-session-context.cjs', 'astera-hook-capture.cjs']
    for (const file of ['astera-statusline-settings.json', 'astera-hooks-settings.json']) {
      expect(await commands(file)).toEqual(scripts.map((s) => captureCommand(node, path.join(dir, s))))
    }
  })

  it('does not touch the files when the node is the one it already has', async () => {
    const mgr = new StatusLineManager(dir, 'C:\\rt\\astera-host.exe')
    await mgr.init()
    const file = path.join(dir, 'astera-hooks-settings.json')
    await fs.writeFile(file, 'left alone', 'utf8')
    await mgr.useNode('C:\\rt\\astera-host.exe')
    expect(await fs.readFile(file, 'utf8')).toBe('left alone')
  })
})

// Observe mode (observe mode design §4, §5): a session started while the mode is observe gets a PostToolUse hook for
// every tool, `async` so no call waits on it; one started in compatibility gets exactly what it got before.
describe('StatusLineManager observe mode', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-observe-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  const hookCmd = (): string => captureCommand('node', path.join(dir, 'astera-hook-capture.cjs'))
  const auditCmd = (): string => captureCommand('node', path.join(dir, 'astera-hook-audit-capture.cjs'))
  /** The two settings files as they were before observe mode, byte for byte. This literal passes against the code
   *  before observe mode was added too, which is what makes it the proof that compatibility is unchanged. */
  const before = (): { base: string; wider: string } => {
    const hook = hookCmd()
    const every = {
      SessionStart: [{ hooks: [{ type: 'command', command: captureCommand('node', path.join(dir, 'astera-session-context.cjs')) }] }],
      Notification: [{ hooks: [{ type: 'command', command: hook }] }],
      Stop: [{ hooks: [{ type: 'command', command: hook }] }],
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hook }] }],
      PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hook }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook, async: true }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: hook, async: true }] }]
    }
    const settings = {
      statusLine: { type: 'command', command: captureCommand('node', path.join(dir, 'astera-statusline-capture.cjs')), padding: 0 },
      hooks: every
    }
    const tools = 'AskUserQuestion|Bash|PowerShell|Write|Edit|NotebookEdit'
    const wider = {
      ...settings,
      hooks: {
        ...every,
        PreToolUse: [{ matcher: tools, hooks: [{ type: 'command', command: hook }] }],
        PostToolUse: [{ matcher: tools, hooks: [{ type: 'command', command: hook }] }]
      }
    }
    return { base: JSON.stringify(settings, null, 2), wider: JSON.stringify(wider, null, 2) }
  }
  const read = (file: string): Promise<string> => fs.readFile(file.replace(/\//g, path.sep), 'utf8')

  it('in compatibility the settings files and the files a session is pointed at are what they were, and nothing else is written', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    const plain = mgr.spawnConfig('s1', account, { toolHooks: false })
    const tools = mgr.spawnConfig('s2', account, { toolHooks: true })
    expect(await read(plain.settingsFile)).toBe(before().base)
    expect(await read(tools.settingsFile)).toBe(before().wider)
    expect(plain.settingsFile).toBe(path.join(dir, 'astera-statusline-settings.json').replace(/\\/g, '/'))
    expect(tools.settingsFile).toBe(path.join(dir, 'astera-hooks-settings.json').replace(/\\/g, '/'))
    expect((await fs.readdir(dir)).filter((f) => /observe|audit/.test(f))).toEqual([])
    expect(plain).not.toHaveProperty('observed')
  })

  it('observe points the session at a file with async PostToolUse and PostToolUseFailure hooks for every tool, through the audit capture', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await mgr.ensureObserveFiles()
    const audit = { matcher: '*', hooks: [{ type: 'command', command: auditCmd(), async: true }] }
    for (const [toolHooks, was] of [[false, before().base], [true, before().wider]] as const) {
      const c = mgr.spawnConfig('s1', account, { toolHooks, observe: true })
      const plain = mgr.spawnConfig('s1', account, { toolHooks })
      expect(c.settingsFile).not.toBe(plain.settingsFile)
      expect(c.observed).toBe(true)
      const expected = JSON.parse(was)
      expected.hooks.PostToolUse.push(audit)
      expected.hooks.PostToolUseFailure = [audit]
      expect(JSON.parse(await read(c.settingsFile))).toEqual(expected)
      // The compatibility file is left as it was
      expect(await read(plain.settingsFile)).toBe(was)
      expect(c.hookOutPath).toBe(plain.hookOutPath)
    }
  })

  it('a session asked to be observed before its files are written gets the plain file, and is not marked observed', () => {
    const mgr = new StatusLineManager(dir)
    const c = mgr.spawnConfig('s1', account, { observe: true })
    expect(c.settingsFile).toBe(mgr.spawnConfig('s1', account).settingsFile)
    expect(c).not.toHaveProperty('observed')
  })

  /** Runs one capture script the way Claude Code runs a hook: the payload on stdin, ASTERA_HOOK_OUT set. */
  const runCapture = async (script: string, out: string, payload: unknown): Promise<void> => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ASTERA_HOOK_OUT: out }, stdio: ['pipe', 'ignore', 'ignore'] })
    const closed = new Promise((r) => child.on('close', r))
    child.stdin.end(JSON.stringify(payload))
    await closed
  }
  const lines = async (file: string): Promise<Array<Record<string, unknown>>> =>
    (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))

  it('the audit capture writes beside the session’s file, keeping what names the call and none of its output', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await mgr.ensureObserveFiles()
    const out = path.join(mgr.hookEventsDir, 's1.jsonl')
    const script = path.join(dir, 'astera-hook-audit-capture.cjs')
    await runCapture(script, out, {
      session_id: 'c', transcript_path: '/t', cwd: '/w', hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: 'a.ts' }, tool_response: { file: { content: 'secret body' } }, tool_use_id: 'toolu_1', duration_ms: 3
    })
    await runCapture(script, out, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_2',
      error: 'secret output', is_interrupt: true, duration_ms: 9
    })
    const got = await lines(path.join(mgr.hookEventsDir, 's1.audit.jsonl'))
    expect(got.map(({ astera_at, ...rest }) => (expect(typeof astera_at).toBe('number'), rest))).toEqual([
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 'toolu_1', cwd: '/w' },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_2', is_interrupt: true }
    ])
    expect(await fs.readFile(path.join(mgr.hookEventsDir, 's1.audit.jsonl'), 'utf8')).not.toContain('secret')
    expect(existsSync(out)).toBe(false)
  })

  // Final review M1: of a tool's input the capture keeps only the fields the resolver reads, so a Write's contents or an
  // Edit's strings never wait on disk until the app's next start
  it('the audit capture keeps of a tool’s input only what the resolver reads, which resolves the same', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await mgr.ensureObserveFiles()
    const out = path.join(mgr.hookEventsDir, 's2.jsonl')
    const script = path.join(dir, 'astera-hook-audit-capture.cjs')
    const inputs: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: '/w/a.ts', content: 'secret body' }],
      ['Edit', { file_path: '/w/a.ts', old_string: 'secret old', new_string: 'secret new', replace_all: true }],
      ['NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'secret cell', cell_id: 'c1' }],
      ['Bash', { command: 'git push', description: 'secret words', timeout: 5000, run_in_background: true }],
      ['Grep', { pattern: 'secret', path: 'src', glob: '*.ts', output_mode: 'content' }],
      ['Glob', { pattern: '/w/src/**/*.ts' }],
      ['WebFetch', { url: 'https://example.com/x', prompt: 'secret prompt' }],
      ['Agent', { description: 'd', prompt: 'secret task' }],
      ['mcp__github__create_issue', { title: 'secret title', body: 'b' }]
    ]
    for (const [tool, input] of inputs) await runCapture(script, out, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_use_id: tool })
    const got = await lines(path.join(mgr.hookEventsDir, 's2.audit.jsonl'))
    expect(got.map((l) => l.tool_input)).toEqual([
      { file_path: '/w/a.ts' },
      { file_path: '/w/a.ts' },
      { notebook_path: '/w/n.ipynb' },
      { command: 'git push' },
      { pattern: 'secret', path: 'src' },
      { pattern: '/w/src/**/*.ts' },
      { url: 'https://example.com/x' },
      {},
      {}
    ])
    for (const [i, [tool, input]] of inputs.entries())
      expect(resolveAction({ provider: 'claude', tool, input: got[i].tool_input, cwd: '/w' }), tool).toEqual(resolveAction({ provider: 'claude', tool, input, cwd: '/w' }))
    // Grep's pattern is the one field kept that may be a person's words; it names no file and is never recorded
    expect(JSON.stringify(got.map((l) => ({ ...(l.tool_input as object), pattern: undefined })))).not.toContain('secret')
  })

  // The review's I2: the session's own hook file is what attention, sessions list, Slack and pendingPrompt read. Fired
  // the way Claude Code fires hooks, an observed session's settings write that file line for line as a plain session's
  // do, so its state and attention are the same; the observe lines go to the audit file only.
  it('an observed session’s own hook file, state and attention are a plain session’s for the same tool events', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await mgr.ensureObserveFiles()
    const scripts = new Map([
      [hookCmd(), path.join(dir, 'astera-hook-capture.cjs')],
      [auditCmd(), path.join(dir, 'astera-hook-audit-capture.cjs')]
    ])
    const tool = (event: string, name: string, id: string, extra: Record<string, unknown> = {}) => ({
      hook_event_name: event, tool_name: name, tool_input: {}, tool_use_id: id, ...extra
    })
    const events = [
      { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
      tool('PreToolUse', 'Bash', 'b1'),
      tool('PostToolUse', 'Bash', 'b1', { tool_response: { stdout: '' } }),
      tool('PreToolUse', 'Write', 'w1'),
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      // A subagent's Read while the permission prompt is up
      tool('PostToolUse', 'Read', 'r1', { tool_response: {} }),
      tool('PostToolUseFailure', 'Grep', 'g1', { error: 'x' })
    ]
    /** Claude Code's dispatch, as far as these files need it: every entry whose matcher takes the tool, in order. */
    const fire = async (settingsFile: string, out: string): Promise<void> => {
      const hooks = JSON.parse(await read(settingsFile)).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
      for (const e of events) {
        const name = (e as { tool_name?: string }).tool_name
        for (const entry of hooks[e.hook_event_name] ?? []) {
          const m = entry.matcher
          if (m !== undefined && m !== '' && m !== '*' && !(name !== undefined && m.split('|').includes(name))) continue
          for (const h of entry.hooks) await runCapture(scripts.get(h.command)!, out, e)
        }
      }
    }
    for (const toolHooks of [false, true]) {
      const plainOut = path.join(mgr.hookEventsDir, `plain-${toolHooks}.jsonl`)
      const observedOut = path.join(mgr.hookEventsDir, `observed-${toolHooks}.jsonl`)
      await fire(mgr.spawnConfig('p', account, { toolHooks }).settingsFile, plainOut)
      await fire(mgr.spawnConfig('o', account, { toolHooks, observe: true }).settingsFile, observedOut)
      const plain = await lines(plainOut)
      const observed = await lines(observedOut)
      const unstamped = (l: Array<Record<string, unknown>>) => l.map(({ astera_at: _, ...rest }) => rest)
      expect(unstamped(observed)).toEqual(unstamped(plain))
      const attentionOf = (l: Array<Record<string, unknown>>) => {
        const a = createAttentionState()
        for (const p of l) a.onHookEvent('s', p)
        return a.get('s')
      }
      expect(attentionOf(observed)).toBe(attentionOf(plain))
      const stateOf = (file: string) => fs.readFile(file, 'utf8').then((t) => hookEventState(JSON.parse(latestEventLine(t.split('\n').filter((x) => x !== ''))!)))
      expect(await stateOf(observedOut)).toBe(await stateOf(plainOut))
      // The observe lines: every tool call that ran or failed, in the audit file only
      expect((await lines(path.join(mgr.hookEventsDir, `observed-${toolHooks}.audit.jsonl`))).map((l) => [l.hook_event_name, l.tool_name])).toEqual([
        ['PostToolUse', 'Bash'],
        ['PostToolUse', 'Read'],
        ['PostToolUseFailure', 'Grep']
      ])
      expect(existsSync(path.join(mgr.hookEventsDir, `plain-${toolHooks}.audit.jsonl`))).toBe(false)
    }
  }, 60_000)

  it('the app’s start empties the audit files with the session files', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await fs.writeFile(path.join(mgr.hookEventsDir, 's1.audit.jsonl'), '{}\n')
    await fs.writeFile(path.join(mgr.hookEventsDir, 's1.jsonl'), '{}\n')
    await mgr.startupCleanup()
    expect(await fs.readdir(mgr.hookEventsDir)).toEqual([])
  })

  it('an observe file that could not be written leaves the session on the plain file', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    const write = fs.writeFile
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((file, ...rest) =>
      String(file).includes('observe') ? Promise.reject(new Error('EACCES')) : write(file, ...(rest as [string]))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await mgr.ensureObserveFiles()
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
    expect(mgr.spawnConfig('s1', account, { observe: true }).settingsFile).toBe(mgr.spawnConfig('s1', account).settingsFile)
  })

  it('writes the observe files again with the node it runs under now', async () => {
    const mgr = new StatusLineManager(dir)
    await mgr.init()
    await mgr.ensureObserveFiles()
    const node = 'C:\\rt\\astera-host.exe'
    await mgr.useNode(node)
    await mgr.ensureObserveFiles()
    const s = JSON.parse(await read(mgr.spawnConfig('s1', account, { observe: true }).settingsFile))
    expect(s.hooks.PostToolUse.at(-1).hooks[0].command).toBe(captureCommand(node, path.join(dir, 'astera-hook-audit-capture.cjs')))
    expect(s.hooks.Stop[0].hooks[0].command).toBe(captureCommand(node, path.join(dir, 'astera-hook-capture.cjs')))
  })
})

// The measurement itself, kept: every command the settings carry, run the way Claude Code runs it,
// from a profile folder with a space and Hangul in it and under the node running this test (on a
// stock install that is C:\Program Files\nodejs, a space of its own).
describe.runIf(process.platform === 'win32')('captureCommand through the shells Claude Code uses on Windows', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const shells: Array<[string, string, (cmd: string) => string[]]> = [
    ['PowerShell', 'powershell.exe', (cmd) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]],
    ...(existsSync(bash) ? [['Git Bash', bash, (cmd: string) => ['-c', cmd]] as [string, string, (cmd: string) => string[]]] : [])
  ]
  let root: string
  let dir: string
  let settings: { statusLine: { command: string }; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-sh-'))
    dir = path.join(root, 'pro file 프로필')
    await new StatusLineManager(dir, process.execPath).init()
    settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  const run = (file: string, args: string[], env: Record<string, string>): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', reject)
      child.on('close', resolve)
      child.stdin.end('{"hook_event_name":"Stop","x":"한글"}')
    })

  for (const [name, file, args] of shells) {
    it(`runs the hook capture through ${name}`, async () => {
      const out = path.join(root, 'hook.jsonl')
      expect(await run(file, args(settings.hooks.Stop[0].hooks[0].command), { ASTERA_HOOK_OUT: out })).toBe(0)
      const line = JSON.parse((await fs.readFile(out, 'utf8')).trim())
      expect(line).toMatchObject({ hook_event_name: 'Stop', x: '한글' })
    }, 30_000)

    it(`runs the statusLine capture through ${name}`, async () => {
      const out = path.join(root, 'status.json')
      expect(await run(file, args(settings.statusLine.command), { ASTERA_STATUSLINE_OUT: out })).toBe(0)
      expect(JSON.parse(await fs.readFile(out, 'utf8'))).toMatchObject({ x: '한글' })
    }, 30_000)
  }
})

// Enforce (enforce design §5, E1, E5): a session started in Enforce runs the blocking hook before every tool call, with
// Astera's own node; an Off or Observe session's files are what they were
describe('StatusLineManager enforce mode', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-enforce-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const read = (file: string): Promise<string> => fs.readFile(file.replace(/\//g, path.sep), 'utf8')

  it('finds Astera’s own node: the Host runtime on Windows, Electron as node elsewhere, none on Windows without the runtime', () => {
    expect(enforceInterpreter({ platform: 'win32', captureNode: 'C:\\rt\\astera-host.exe', execPath: 'C:/x/electron.exe' })).toEqual({ file: 'C:\\rt\\astera-host.exe' })
    expect(enforceInterpreter({ platform: 'win32', captureNode: 'node', execPath: 'C:/x/electron.exe' })).toBeNull()
    expect(enforceInterpreter({ platform: 'linux', captureNode: '/usr/bin/node', execPath: '/opt/astera/astera' })).toEqual({ file: '/opt/astera/astera', env: 'ELECTRON_RUN_AS_NODE=1' })
    expect(enforceCommand({ file: '/opt/astera/astera', env: 'ELECTRON_RUN_AS_NODE=1' }, '/p/astera-enforce-hook.cjs', 'claude')).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/opt/astera/astera" "/p/astera-enforce-hook.cjs" claude'
    )
    // Both CLIs run a hook's line in a shell that reads captureCommand's form: Claude Code in Git Bash or PowerShell,
    // Codex in its own session shell, PowerShell on Windows (codex-rs core/src/session/mod.rs build_hooks_config,
    // shell-command/src/shell_detect.rs, rust-v0.160.0). The quoted form fails there (measured 2026-10-27).
    expect(enforceCommand({ file: 'C:/rt/astera-host.exe' }, 'C:/p/astera-enforce-hook.cjs', 'claude')).toBe("C:'/rt/astera-host.exe' 'C:/p/astera-enforce-hook.cjs' claude")
    expect(enforceCommand({ file: 'C:\\rt\\astera-host.exe' }, 'C:\\p\\astera-enforce-hook.cjs', 'codex')).toBe("C:'/rt/astera-host.exe' 'C:/p/astera-enforce-hook.cjs' codex")
    expect(enforceCommand({ file: '/opt/astera/astera', env: 'ELECTRON_RUN_AS_NODE=1' }, '/p/astera-enforce-hook.cjs', 'codex')).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/opt/astera/astera" "/p/astera-enforce-hook.cjs" codex'
    )
  })

  it('runs an AppImage’s hook through the AppImage file, not its mount, which is gone once the app quits', () => {
    const i = enforceInterpreter({ platform: 'linux', captureNode: 'node', execPath: '/tmp/.mount_AsterX/astera', appImage: '/home/u/Astera.AppImage' })
    expect(i).toEqual({ file: '/home/u/Astera.AppImage', env: 'ELECTRON_RUN_AS_NODE=1', tail: '--no-sandbox' })
    // After the provider, so the hook still reads it as argv[2]; there, AppRun sees one and adds none in front (shuttle.ts)
    expect(enforceCommand(i!, '/p/astera-enforce-hook.cjs', 'claude')).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/home/u/Astera.AppImage" "/p/astera-enforce-hook.cjs" claude --no-sandbox'
    )
    expect(enforceInterpreter({ platform: 'darwin', captureNode: 'node', execPath: '/Applications/Astera.app/Contents/MacOS/Astera', appImage: '' })).toEqual({
      file: '/Applications/Astera.app/Contents/MacOS/Astera',
      env: 'ELECTRON_RUN_AS_NODE=1'
    })
    // Final review M9: a macOS app run where it was downloaded is translocated to a path that goes with it
    expect(
      enforceInterpreter({ platform: 'darwin', captureNode: 'node', execPath: '/private/var/folders/x/T/AppTranslocation/1A2B/d/Astera.app/Contents/MacOS/Astera' })
    ).toBeNull()
  })

  it('writes the enforce hook and settings with a synchronous PreToolUse for every tool', async () => {
    const mgr = new StatusLineManager(dir, 'node', () => {}, { platform: 'linux', execPath: '/opt/astera/astera' })
    await mgr.init()
    expect(await mgr.ensureEnforceFiles()).toBe('ok')
    expect(await fs.readFile(path.join(dir, ENFORCE_HOOK_FILE), 'utf8')).toBe(enforceHookSource)
    const pre = { matcher: '*', hooks: [{ type: 'command', command: `ELECTRON_RUN_AS_NODE=1 "/opt/astera/astera" "${path.join(dir, ENFORCE_HOOK_FILE).replace(/\\/g, '/')}" claude`, timeout: 10 }] }
    for (const toolHooks of [false, true]) {
      const c = mgr.spawnConfig('s1', account, { toolHooks, observe: true, enforce: true })
      const observed = mgr.spawnConfig('s1', account, { toolHooks, observe: true })
      expect(c).toMatchObject({ observed: true, enforced: true })
      expect(c.settingsFile).not.toBe(observed.settingsFile)
      const expected = JSON.parse(await read(observed.settingsFile))
      expected.hooks.PreToolUse.push(pre)
      // Final review C2, measured 2026-10-27: a project's `.claude/settings.local.json` with "disableAllHooks": true
      // turned the hook off; this file is --settings, above project, local and user settings, and turns it back on
      expected.disableAllHooks = false
      expect(JSON.parse(await read(c.settingsFile))).toEqual(expected)
    }
    // A chat session takes only the blocking hook, through --settings
    const args = mgr.enforceChatArgs()
    expect(args?.[0]).toBe('--settings')
    expect(JSON.parse(await read(args![1]))).toEqual({ disableAllHooks: false, hooks: { PreToolUse: [pre] } })
    // A Codex session takes the same hook, for codex, through -c
    expect(mgr.enforceCodexArgs()).toEqual(
      codexEnforceArgs({ command: `ELECTRON_RUN_AS_NODE=1 "/opt/astera/astera" "${path.join(dir, ENFORCE_HOOK_FILE).replace(/\\/g, '/')}" codex`, platform: 'linux' })
    )
  })

  // Final review M2: a file that could not be written is not a missing interpreter
  it('says the hook could not be written when its files cannot be', async () => {
    const mgr = new StatusLineManager(dir, 'node', () => {}, { platform: 'linux', execPath: '/opt/astera/astera' })
    await mgr.init()
    // A folder where the settings file goes: neither the swap nor the write in place can put a file there
    await fs.mkdir(path.join(dir, 'astera-enforce-settings.json'))
    expect(await mgr.ensureEnforceFiles()).toBe('hook-write-failed')
    expect(mgr.enforceChatArgs()).toBeNull()
  })

  it('leaves the off and observe settings byte for byte as they were', async () => {
    const mgr = new StatusLineManager(dir, 'node', () => {}, { platform: 'linux', execPath: '/opt/astera/astera' })
    await mgr.init()
    await mgr.ensureObserveFiles()
    const files = [false, true].flatMap((toolHooks) => [mgr.spawnConfig('s', account, { toolHooks }).settingsFile, mgr.spawnConfig('s', account, { toolHooks, observe: true }).settingsFile])
    const was = await Promise.all(files.map(read))
    await mgr.ensureEnforceFiles()
    expect(await Promise.all(files.map(read))).toEqual(was)
  })

  it('runs the hook with a Host runtime Astera installed when the capture scripts have no node of Astera’s', async () => {
    const mgr = new StatusLineManager(dir, 'node', () => {}, { platform: 'win32', execPath: 'C:/x/electron.exe', findRuntime: async () => 'C:\\rt\\astera-host.exe' })
    await mgr.init()
    expect(await mgr.ensureEnforceFiles()).toBe('ok')
    expect(mgr.enforceHookCommand('claude')).toBe(`C:'/rt/astera-host.exe' '${path.join(dir, ENFORCE_HOOK_FILE).replace(/\\/g, '/')}' claude`)
    // The capture scripts keep their own node, so an Off or Observe session's settings are as they were
    const plain = JSON.parse(await read(mgr.spawnConfig('s', account).settingsFile))
    expect(JSON.stringify(plain)).not.toContain('astera-host.exe')
  })

  it('has no interpreter on Windows without the Host runtime, so a session asked to enforce is not marked enforced', async () => {
    const mgr = new StatusLineManager(dir, 'node', () => {}, { platform: 'win32', execPath: 'C:/x/electron.exe' })
    await mgr.init()
    expect(await mgr.ensureEnforceFiles()).toBe('no-interpreter')
    expect(mgr.spawnConfig('s1', account, { observe: true, enforce: true })).not.toHaveProperty('enforced')
    expect(mgr.enforceChatArgs()).toBeNull()
    expect(mgr.enforceCodexArgs()).toBeNull()
  })
})

// The sandbox (sandbox design §6): a sandboxed Claude session reads the twin of the file it would read anyway, the same
// JSON with Claude's sandbox and the deny rules added (claudeSandboxSettings), so a session without it reads exactly the
// bytes it always did.
describe('StatusLineManager sandbox', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-sandbox-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const read = (file: string): Promise<string> => fs.readFile(file.replace(/\//g, path.sep), 'utf8')
  const HOME = { linux: '/home/t', darwin: '/Users/t', win32: 'C:\\Users\\t' } as const
  const ENV = {
    linux: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    darwin: {},
    win32: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }
  } as const
  const TMP = { linux: '/tmp', darwin: '/var/folders/x/T', win32: 'C:\\Users\\t\\AppData\\Local\\Temp' } as const
  const managerOn = (platform: 'linux' | 'darwin' | 'win32') =>
    new StatusLineManager(dir, 'node', () => {}, {
      platform,
      execPath: platform === 'win32' ? 'C:/x/electron.exe' : '/opt/astera/astera',
      ...(platform === 'win32' ? { findRuntime: async () => 'C:\\rt\\astera-host.exe' } : {}),
      homeDir: HOME[platform],
      env: { ...ENV[platform] },
      tmpDir: TMP[platform]
    })
  /** What the builder gives for this OS, from the manager's home and environment. */
  const builder = (platform: 'linux' | 'darwin' | 'win32') => {
    const env = { ...ENV[platform] }
    const denied = [...sensitiveLocations(platform, env, HOME[platform]), ...credentialStoreDenies(platform, env, HOME[platform])]
    return claudeSandboxSettings({ platform, denied, npmCache: npmCacheOf(TMP[platform]) })
  }
  const VARIANTS = [{}, { observe: true }, { observe: true, enforce: true }].flatMap((o) => [false, true].map((toolHooks) => ({ ...o, toolHooks })))

  it('every variant has a sandbox twin that differs only by sandbox and deny rules', async () => {
    const mgr = managerOn('linux')
    await mgr.init()
    expect(await mgr.ensureEnforceFiles()).toBe('ok')
    expect(await mgr.ensureSandboxFiles()).toBe('ok')
    const want = builder('linux')
    expect(want.sandbox).toBeDefined()
    expect(want.permissions.deny).toContain('Read(//home/t/.ssh/**)')
    const twins = new Set<string>()
    for (const o of VARIANTS) {
      const plain = mgr.spawnConfig('s1', account, o)
      const boxed = mgr.spawnConfig('s1', account, { ...o, sandbox: true })
      expect(plain, JSON.stringify(o)).not.toHaveProperty('sandboxed')
      expect(boxed).toMatchObject({ sandboxed: true, outPath: plain.outPath, hookOutPath: plain.hookOutPath })
      expect(boxed.observed).toBe(plain.observed)
      expect(boxed.enforced).toBe(plain.enforced)
      // Beside the file it would read, named for it
      expect(boxed.settingsFile).toBe(plain.settingsFile.replace(/\.json$/, '-sandbox.json'))
      twins.add(boxed.settingsFile)
      const a = JSON.parse(await read(plain.settingsFile))
      const b = JSON.parse(await read(boxed.settingsFile))
      expect(b.sandbox).toEqual(want.sandbox)
      expect(b.permissions).toEqual({ deny: want.permissions.deny })
      delete b.sandbox
      delete b.permissions
      expect(b).toEqual(a)
    }
    // Six files: plain, hooks, observe, observe hooks, enforce, enforce hooks
    expect(twins.size).toBe(6)
    // A chat takes only the sandbox, with nothing of the terminal's hooks
    const chat = mgr.sandboxChatArgs(false)
    expect(chat?.[0]).toBe('--settings')
    expect(chat?.[1]).toBe(path.join(dir, 'astera-sandbox-chat-settings.json').replace(/\\/g, '/'))
    expect(JSON.parse(await read(chat![1]))).toEqual({ sandbox: want.sandbox, permissions: { deny: want.permissions.deny } })
  })

  it('an unsandboxed session’s settings file is today’s, at the same path with the same bytes', async () => {
    const mgr = managerOn('linux')
    await mgr.init()
    await mgr.ensureEnforceFiles()
    const files = VARIANTS.map((o) => mgr.spawnConfig('s1', account, o).settingsFile)
    expect(files.map((f) => path.basename(f))).toEqual([
      'astera-statusline-settings.json',
      'astera-hooks-settings.json',
      'astera-observe-settings.json',
      'astera-observe-hooks-settings.json',
      'astera-enforce-settings.json',
      'astera-enforce-hooks-settings.json'
    ])
    const was = await Promise.all(files.map(read))
    const chatWas = mgr.enforceChatArgs()
    const chatBytes = await read(chatWas![1])
    expect(await mgr.ensureSandboxFiles()).toBe('ok')
    for (const sandbox of [undefined, false]) {
      const now = VARIANTS.map((o) => mgr.spawnConfig('s1', account, { ...o, ...(sandbox === undefined ? {} : { sandbox }) }))
      expect(now.map((c) => c.settingsFile)).toEqual(files)
      for (const c of now) expect(c).not.toHaveProperty('sandboxed')
    }
    expect(await Promise.all(files.map(read))).toEqual(was)
    expect(mgr.enforceChatArgs()).toEqual(chatWas)
    expect(await read(chatWas![1])).toBe(chatBytes)
  })

  it('Enforce and sandbox together: one file with both', async () => {
    const mgr = managerOn('linux')
    await mgr.init()
    // Asked for in either order (a Host chat prepares the sandbox before its capabilities refresh writes Enforce's files)
    expect(await mgr.ensureSandboxFiles()).toBe('ok')
    expect(mgr.sandboxChatArgs(true)).toBeNull()
    expect(mgr.spawnConfig('s1', account, { observe: true, enforce: true, sandbox: true })).not.toHaveProperty('enforced')
    expect(await mgr.ensureEnforceFiles()).toBe('ok')
    const want = builder('linux')
    const pre = { matcher: '*', hooks: [{ type: 'command', command: mgr.enforceHookCommand('claude'), timeout: 10 }] }
    const c = mgr.spawnConfig('s1', account, { observe: true, enforce: true, sandbox: true })
    expect(c).toMatchObject({ observed: true, enforced: true, sandboxed: true })
    const both = JSON.parse(await read(c.settingsFile))
    expect(both.hooks.PreToolUse).toContainEqual(pre)
    expect(both.disableAllHooks).toBe(false)
    expect(both.sandbox).toEqual(want.sandbox)
    expect(both.permissions.deny).toEqual(want.permissions.deny)
    // A chat's one --settings carries both too
    const chat = mgr.sandboxChatArgs(true)
    expect(chat?.[1]).toBe(path.join(dir, 'astera-enforce-sandbox-chat-settings.json').replace(/\\/g, '/'))
    expect(JSON.parse(await read(chat![1]))).toEqual({ disableAllHooks: false, hooks: { PreToolUse: [pre] }, sandbox: want.sandbox, permissions: { deny: want.permissions.deny } })
  })

  // Task 2's ruling (inventory §23.4): srt on macOS lets a sandboxed command connect to a Unix socket it names, so `astera`
  // reaches the Host even in a line excludedCommands does not take out (`cd x && astera …`); Linux ignores the list
  it('on macOS the sandbox names the Host’s socket, and on Linux it does not', async () => {
    const mac = managerOn('darwin')
    await mac.init()
    await mac.ensureSandboxFiles()
    const boxed = JSON.parse(await read(mac.spawnConfig('s1', account, { sandbox: true }).settingsFile))
    const socket = hostAddress({ profileDir: dir, platform: 'darwin', tmpDir: TMP.darwin, protocol: HOST_PROTOCOL }).address
    expect(socket).toMatch(/^\/var\/folders\/x\/T\/astera-host-[0-9a-f]{12}-v\d+\/sock$/)
    // Task 7 fix round 1: one address, which the session is told too (ASTERA_HOST, claudeStart.ts), since `$TMPDIR` inside
    // the sandbox is not the app's; and Seatbelt sees `/var` as the real `/private/var`, so both spellings are granted
    expect(mac.hostSocket()).toBe(socket)
    expect(boxed.sandbox).toEqual({ ...builder('darwin').sandbox, network: { allowUnixSockets: [socket, `/private${socket}`] } })
    expect(boxed.permissions.deny).toContain('Read(//Users/t/Library/Keychains/**)')
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir)
    const linux = managerOn('linux')
    await linux.init()
    await linux.ensureSandboxFiles()
    expect(JSON.parse(await read(linux.spawnConfig('s1', account, { sandbox: true }).settingsFile)).sandbox).not.toHaveProperty('network')
    expect(linux.hostSocket()).toBeNull()
    expect(managerOn('win32').hostSocket()).toBeNull()
  })

  // Task 7 fix round 1: a person who points Astera at a Host by hand (ASTERA_HOST) keeps it, and it is that address that is
  // granted; one outside `/var` and `/tmp` has no other spelling
  it('on macOS the person’s own ASTERA_HOST is the socket granted', async () => {
    const mac = new StatusLineManager(dir, 'node', () => {}, {
      platform: 'darwin', execPath: '/opt/astera/astera', homeDir: HOME.darwin, env: { ASTERA_HOST: '/Users/t/hosts/mine.sock' }, tmpDir: TMP.darwin
    })
    await mac.init()
    await mac.ensureSandboxFiles()
    expect(mac.hostSocket()).toBe('/Users/t/hosts/mine.sock')
    const boxed = JSON.parse(await read(mac.spawnConfig('s1', account, { sandbox: true }).settingsFile))
    expect(boxed.sandbox.network).toEqual({ allowUnixSockets: ['/Users/t/hosts/mine.sock'] })
    const tmp = new StatusLineManager(dir, 'node', () => {}, {
      platform: 'darwin', execPath: '/opt/astera/astera', homeDir: HOME.darwin, env: { ASTERA_HOST: '/tmp/h/sock' }, tmpDir: TMP.darwin
    })
    await tmp.init()
    await tmp.ensureSandboxFiles()
    expect(JSON.parse(await read(tmp.spawnConfig('s1', account, { sandbox: true }).settingsFile)).sandbox.network).toEqual({
      allowUnixSockets: ['/tmp/h/sock', '/private/tmp/h/sock']
    })
  })

  it('on Windows the twin holds the deny rules only, in Claude’s POSIX form', async () => {
    const mgr = managerOn('win32')
    await mgr.init()
    expect(await mgr.ensureSandboxFiles()).toBe('ok')
    const c = mgr.spawnConfig('s1', account, { sandbox: true })
    expect(c.sandboxed).toBe(true)
    const boxed = JSON.parse(await read(c.settingsFile))
    expect(boxed).not.toHaveProperty('sandbox')
    expect(boxed.permissions.deny).toEqual(builder('win32').permissions.deny)
    expect(boxed.permissions.deny).toContain('Read(//c/Users/t/.ssh/**)')
    expect(boxed.permissions.deny).toContain('Read(//c/Users/t/AppData/Roaming/GitHub CLI/**)')
  })

  it('a twin that could not be written leaves the session unsandboxed, which its manager refuses', async () => {
    const mgr = managerOn('linux')
    await mgr.init()
    // A folder where the twin goes: neither the swap nor the write in place can put a file there
    await fs.mkdir(path.join(dir, 'astera-statusline-settings-sandbox.json'))
    expect(await mgr.ensureSandboxFiles()).toBe('write-failed')
    expect(mgr.spawnConfig('s1', account, { sandbox: true })).not.toHaveProperty('sandboxed')
    // The other twins are still in place
    expect(mgr.spawnConfig('s1', account, { toolHooks: true, sandbox: true }).sandboxed).toBe(true)
  })

  // A session reads its settings once, at start, and the files are rewritten whenever what they hold changes: a twin
  // built before such a change is not handed out after it
  it('the twins follow the files they are twins of', async () => {
    const mgr = managerOn('linux')
    await mgr.init()
    await mgr.ensureSandboxFiles()
    await mgr.useNode('/usr/local/bin/node')
    const c = mgr.spawnConfig('s1', account, { sandbox: true })
    expect(c.sandboxed).toBe(true)
    expect(await read(c.settingsFile)).toContain('/usr/local/bin/node')
  })
})
