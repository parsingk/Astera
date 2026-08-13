import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HookEventWatcher } from './hookEvents'

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
    // fs.watch 이벤트는 비동기 — 최대 3초 폴링 대기
    const deadline = Date.now() + 3_000
    while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([{ sessionId: 'sess-9', payload: { live: 1 } }])
  })
})
