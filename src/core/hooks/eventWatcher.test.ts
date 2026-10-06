import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { HookEventWatcher } from './eventWatcher'

describe('HookEventWatcher', () => {
  let dir: string
  let events: { sessionId: string; payload: unknown }[]
  let logs: string[]
  let watcher: HookEventWatcher

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hooks-'))
    events = []
    logs = []
    watcher = new HookEventWatcher(dir, (sessionId, payload) => events.push({ sessionId, payload }), (m) => logs.push(m))
  })
  afterEach(async () => {
    watcher.stop()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('drain: 완전한 줄들을 파싱해 파일명에서 딴 sessionId와 함께 콜백한다', async () => {
    const file = path.join(dir, 'sess-1.jsonl')
    await fs.appendFile(file, '{"hook_event_name":"Stop"}\n{"hook_event_name":"Notification"}\n', 'utf8')
    await watcher.drain(file)
    expect(events).toEqual([
      { sessionId: 'sess-1', payload: { hook_event_name: 'Stop' } },
      { sessionId: 'sess-1', payload: { hook_event_name: 'Notification' } }
    ])
  })

  it('drain: 오프셋을 기억해 새 줄만 다시 전달한다', async () => {
    const file = path.join(dir, 'sess-1.jsonl')
    await fs.appendFile(file, '{"n":1}\n', 'utf8')
    await watcher.drain(file)
    await fs.appendFile(file, '{"n":2}\n', 'utf8')
    await watcher.drain(file)
    expect(events.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('drain: 마지막 개행이 없는(쓰는 중일 수 있는) 줄은 다음 호출로 미룬다', async () => {
    const file = path.join(dir, 'sess-1.jsonl')
    await fs.appendFile(file, '{"n":1}', 'utf8') // 개행 없음
    await watcher.drain(file)
    expect(events).toEqual([])
    await fs.appendFile(file, '\n', 'utf8')
    await watcher.drain(file)
    expect(events.map((e) => e.payload)).toEqual([{ n: 1 }])
  })

  it('drain: 깨진 JSON 줄은 스킵·로그하고 나머지는 전달한다', async () => {
    const file = path.join(dir, 'sess-1.jsonl')
    await fs.appendFile(file, '{broken\n{"ok":true}\n', 'utf8')
    await watcher.drain(file)
    expect(events.map((e) => e.payload)).toEqual([{ ok: true }])
    expect(logs.some((l) => l.includes('parse skipped'))).toBe(true)
  })

  it('drain: 멀티바이트(한글·이모지) 내용을 byte offset으로 정확히 증분 처리한다', async () => {
    const file = path.join(dir, 'sess-k.jsonl')
    await fs.appendFile(file, JSON.stringify({ message: '안녕하세요 권한이 필요합니다' }) + '\n', 'utf8')
    await watcher.drain(file)
    await fs.appendFile(file, JSON.stringify({ message: '두 번째 한글 메시지 😀' }) + '\n', 'utf8')
    await watcher.drain(file)
    expect(events.map((e) => e.payload)).toEqual([
      { message: '안녕하세요 권한이 필요합니다' },
      { message: '두 번째 한글 메시지 😀' }
    ])
  })

  it('drain: 파일이 축소(교체)되면 오프셋을 리셋해 새 내용을 처음부터 전달한다', async () => {
    const file = path.join(dir, 'sess-t.jsonl')
    await fs.appendFile(file, '{"n":1}\n{"n":2}\n', 'utf8')
    await watcher.drain(file)
    await fs.writeFile(file, '{"n":9}\n', 'utf8') // 이전보다 짧게 교체
    await watcher.drain(file)
    expect(events.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 9 }])
  })

  it('drain: fs 오류(없는 파일·디렉터리)에도 reject하지 않고 조용히 resolve한다 — unhandled rejection 방지', async () => {
    // fire-and-forget(void drain)이라 open·stat·read 중 무엇이 throw해도 reject되면 메인 프로세스
    // unhandled rejection이 된다. open 실패(없는 파일)와 open 성공 후 read 실패(디렉터리 fd,
    // EISDIR)를 모두 삼키는지 확인 — 둘 다 outer try/catch가 잡아야 한다.
    await expect(watcher.drain(path.join(dir, 'does-not-exist.jsonl'))).resolves.toBeUndefined()
    await expect(watcher.drain(dir)).resolves.toBeUndefined() // dir 자체를 넘김: open OK나 이후 실패
    expect(events).toEqual([])
  })

  it('start: fs.watch로 append를 감지해 콜백한다 (통합)', async () => {
    watcher.start()
    const file = path.join(dir, 'sess-9.jsonl')
    await fs.appendFile(file, '{"live":1}\n', 'utf8')
    // fs.watch 이벤트는 비동기다. 기다리는 방식은 core/history/index.test.ts 가 같은 파일 감시를
    // 기다리는 방식과 같다 — 손으로 만든 폴링 루프는 실패했을 때 "빈 배열이 기대값과 다르다" 라고만
    // 말해서, 이벤트가 안 온 건지 늦게 온 건지를 가리지 못한다.
    //
    // 3초로 박아두었던 것을 8초로 늘렸다. macOS 의 fs.watch 는 FSEvents 라 자체 지연이 있고,
    // 러너가 붐비면 3초를 넘긴다 — `git push main --tags` 가 CI 와 릴리스 워크플로를 동시에
    // 출발시켜 같은 러너를 둘이 잡는 순간이 그렇다(v1.3.24 태그에서 실측). 이 테스트 자체의
    // 타임아웃은 10초(vitest.config.ts)이니, 그보다 짧게 다시 좀히는 숫자는 느린 러너를 빨간
    // 빌드로 바꾸는 일 말고는 하는 일이 없다.
    //
    // **그런데 기다리는 것만으로는 부족하다 — 늦게 오는 게 아니라 아예 안 오기도 한다.** 전체
    // 스위트를 돌릴 때(워커 열 개가 저마다 감시자를 띄운다) 이 테스트가 이따금 죽길래 대기를
    // 45초까지 늘려 봤더니, 45초가 지나도 이벤트는 0건이고 watcher 쪽 로그는 비어 있었다 —
    // watch() 는 멀쩡히 무장했고 파일도 그 자리에 있는데 FSEvents 가 알림을 통째로 빠뜨린 것이다
    // (단독 실행에서는 60회 중 0회라 대기 시간을 늘리는 것으로는 영영 잡히지 않는다).
    //
    // 그래서 알림이 오지 않으면 파일의 mtime 을 건드려 다음 알림을 만든다. 이것이 단언을 무르게
    // 하지 않는 이유는 drain 이 오프셋을 기억하기 때문이다 — 몇 번을 건드리든 이미 읽은 바이트는
    // 다시 전달되지 않으므로, 아래 단언은 여전히 "그 줄이 정확히 한 번" 을 요구한다.
    //
    // 실제 앱도 같은 노출을 안고 있고, 같은 방식으로 스스로 낫는다: 알림을 하나 놓쳐도 그 파일에
    // 다음 줄이 쓰이는 순간의 drain 이 오프셋부터 다시 읽어 빠뜨린 줄까지 함께 올린다.
    await vi.waitFor(
      async () => {
        if (events.length === 0) await fs.utimes(file, new Date(), new Date())
        expect(events.length).toBeGreaterThan(0)
      },
      { timeout: 8_000, interval: 100 }
    )
    expect(events).toEqual([{ sessionId: 'sess-9', payload: { live: 1 } }])
  })

  // 주기적 훑기. fs.watch 의 알림은 오지 않을 수 있고(위 테스트의 주석에 실측이 있다), 알림이
  // 오지 않으면 drain 을 부르는 것이 세상에 하나도 없다 — 그 파일에 다음 줄이 쓰이기 전까지는.
  // 세션의 마지막 Stop 이 바로 그 자리다: 뒤이을 쓰기가 없어서 영영 올라오지 않고, 그러면 앱은
  // 끝난 세션을 계속 '작업 중' 으로 두고 Slack 완료 알림도 보내지 않는다.
  describe('sweep — 알림을 놓쳐도 건져 올리는 재조정', () => {
    it('fs.watch 알림이 하나도 없어도 새 줄을 올린다', async () => {
      const file = path.join(dir, 'sess-s.jsonl')
      await fs.appendFile(file, '{"swept":1}\n', 'utf8')
      await watcher.sweep() // start() 도 하지 않았다 — 감시자는 아무 알림도 받지 못했다
      expect(events).toEqual([{ sessionId: 'sess-s', payload: { swept: 1 } }])
    })

    it('이미 올린 줄은 두 번 올리지 않는다 — 훑기가 중복 알림이 되지 않는 이유', async () => {
      const file = path.join(dir, 'sess-s.jsonl')
      await fs.appendFile(file, '{"swept":1}\n', 'utf8')
      await watcher.sweep()
      await watcher.sweep()
      await watcher.sweep()
      expect(events).toEqual([{ sessionId: 'sess-s', payload: { swept: 1 } }])
    })

    it('.jsonl 이 아닌 파일은 건드리지 않는다', async () => {
      await fs.writeFile(path.join(dir, 'notes.txt'), '{"n":1}\n', 'utf8')
      await watcher.sweep()
      expect(events).toEqual([])
    })

    it('디렉터리가 사라져도 reject 하지 않는다 — fire-and-forget 이라 unhandled rejection 이 된다', async () => {
      await fs.rm(dir, { recursive: true, force: true })
      await expect(watcher.sweep()).resolves.toBeUndefined()
      expect(events).toEqual([])
    })

    // 아래 둘은 훑기가 *걸리고 풀리는지* 만 본다. 훑기가 실제로 줄을 올린다는 것은 위의 테스트들이
    // 이미 증명했다. 여기서 파일을 두고 기다리는 방식을 쓰지 않는 이유는 그것이 결정적이지 않기
    // 때문이다 — start() 직전에 만든 파일을 macOS 의 FSEvents 가 합쳐서 알려 주는 것을 측정했고,
    // 그러면 훑기가 죽어 있어도 테스트는 초록이 된다(실제로 그렇게 통과하는 것을 보고 고쳤다).
    it('start 가 훑기를 주기적으로 부른다', async () => {
      const w = new HookEventWatcher(dir, () => {}, (m) => logs.push(m), 20)
      const spy = vi.spyOn(w, 'sweep')
      try {
        w.start()
        await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 20 })
      } finally {
        w.stop()
      }
    })

    it('stop 이 훑기를 멈춘다', async () => {
      const w = new HookEventWatcher(dir, () => {}, (m) => logs.push(m), 20)
      const spy = vi.spyOn(w, 'sweep')
      w.start()
      await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 20 })
      w.stop()
      const afterStop = spy.mock.calls.length
      await new Promise((r) => setTimeout(r, 200)) // 주기의 열 배
      expect(spy.mock.calls.length).toBe(afterStop)
    })
  })

  describe('its folder removed under it (the app relaunching under a Host that outlives it)', () => {
    /** A watch that behaves as win32's did when the measured Host spun (2026-10-06): once the folder is
     *  gone it raises no 'error' and keeps firing 'rename' named after the folder's own path. */
    function fakeWatch() {
      const made: Array<{ fire(ev: string, name: string): void; closes: number }> = []
      const watchFn = ((_dir: string, listener: (ev: string, name: string | null) => void) => {
        const w = Object.assign(new EventEmitter(), {
          closes: 0,
          close() {
            w.closes++
          },
          fire: (ev: string, name: string) => listener(ev, name)
        })
        made.push(w)
        return w
      }) as unknown as typeof import('node:fs').watch
      return { made, watchFn }
    }

    it('closes the watch at the first event after the folder went, and arms a new one once it is back', async () => {
      const { made, watchFn } = fakeWatch()
      const got: unknown[] = []
      const w = new HookEventWatcher(dir, (_sid, p) => got.push(p), (m) => logs.push(m), 60_000, { watch: watchFn })
      w.start()
      expect(made).toHaveLength(1)

      await fs.rm(dir, { recursive: true, force: true })
      const ownPath = `\\\\?\\${dir}`
      for (let i = 0; i < 1000; i++) made[0].fire('rename', ownPath)
      // One close, one line: the storm ends at its first event instead of running for the Host's life.
      expect(made[0].closes).toBe(1)
      expect(logs.filter((l) => l.includes('was removed'))).toHaveLength(1)

      // Still gone at the sweep: nothing is armed.
      await w.sweep()
      expect(made).toHaveLength(1)

      // Back: the sweep arms a new watch, and a session file in the new folder is read from its start.
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 's1.jsonl'), '{"n":1}\n')
      await w.sweep()
      expect(made).toHaveLength(2)
      expect(got).toEqual([{ n: 1 }])
      await fs.appendFile(path.join(dir, 's1.jsonl'), '{"n":2}\n')
      made[1].fire('change', 's1.jsonl')
      await vi.waitFor(() => expect(got).toEqual([{ n: 1 }, { n: 2 }]))
      w.stop()
      expect(made[1].closes).toBe(1)
    })

    it('a folder already made again is a new folder: the old watch is closed and the new one watched at once', async () => {
      const { made, watchFn } = fakeWatch()
      const w = new HookEventWatcher(dir, () => {}, (m) => logs.push(m), 60_000, { watch: watchFn })
      w.start()
      // The old folder is renamed away rather than removed, so it still exists and the new folder at the
      // path cannot be handed its file id.
      const moved = `${dir}-old`
      await fs.rename(dir, moved)
      await fs.mkdir(dir)
      try {
        made[0].fire('rename', `\\\\?\\${dir}`)
        expect(made[0].closes).toBe(1)
        expect(made).toHaveLength(2)
        made[1].fire('rename', 'notes.txt')
        expect(made[1].closes).toBe(0)
      } finally {
        w.stop()
        await fs.rm(moved, { recursive: true, force: true })
      }
    })

    it('the sweep finds a folder replaced without a single event, closes the old watch and arms the new folder', async () => {
      const { made, watchFn } = fakeWatch()
      const w = new HookEventWatcher(dir, () => {}, (m) => logs.push(m), 60_000, { watch: watchFn })
      w.start()
      const moved = `${dir}-old`
      await fs.rename(dir, moved)
      await fs.mkdir(dir)
      try {
        await w.sweep()
        expect(made[0].closes).toBe(1)
        expect(made).toHaveLength(2)
        // The same folder at the next sweep: nothing more is closed or opened.
        await w.sweep()
        expect(made).toHaveLength(2)
        expect(made[1].closes).toBe(0)
      } finally {
        w.stop()
        await fs.rm(moved, { recursive: true, force: true })
      }
    })

    it('a folder that is briefly unreadable and then the same folder again keeps its offsets: nothing is delivered twice', async () => {
      const { made, watchFn } = fakeWatch()
      const got: unknown[] = []
      const w = new HookEventWatcher(dir, (_sid, p) => got.push(p), (m) => logs.push(m), 60_000, { watch: watchFn })
      await fs.writeFile(path.join(dir, 's1.jsonl'), '{"n":1}\n')
      w.start()
      await w.sweep()
      expect(got).toEqual([{ n: 1 }])
      // Away for a moment (as an access that fails once would read), then back: the same folder.
      const away = `${dir}-away`
      await fs.rename(dir, away)
      made[0].fire('rename', `\\\\?\\${dir}`)
      expect(made[0].closes).toBe(1)
      await fs.rename(away, dir)
      await w.sweep()
      expect(made).toHaveLength(2)
      expect(got).toEqual([{ n: 1 }])
      w.stop()
    })

    it('leaves the watch alone for an event that is not a session file while the folder is there', () => {
      const { made, watchFn } = fakeWatch()
      const w = new HookEventWatcher(dir, () => {}, (m) => logs.push(m), 60_000, { watch: watchFn })
      w.start()
      made[0].fire('rename', 'notes.txt')
      expect(made[0].closes).toBe(0)
      w.stop()
    })
  })

  it('with startAtEnd, skips what the files already held and delivers what is appended after start (S6 R13)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hookw-'))
    try {
      await fs.writeFile(path.join(dir, 's1.jsonl'), JSON.stringify({ hook_event_name: 'Notification', old: true }) + '\n')
      const got: unknown[] = []
      const w = new HookEventWatcher(dir, (_sid, p) => got.push(p), () => {}, 50, { startAtEnd: true })
      w.start()
      await new Promise((r) => setTimeout(r, 120))
      expect(got).toEqual([])
      await fs.appendFile(path.join(dir, 's1.jsonl'), JSON.stringify({ hook_event_name: 'Notification', fresh: true }) + '\n')
      await vi.waitFor(() => expect(got).toEqual([{ hook_event_name: 'Notification', fresh: true }]), { timeout: 2000 })
      w.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
