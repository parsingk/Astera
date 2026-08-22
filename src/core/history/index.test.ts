import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, watch as fsWatch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, Provider } from '../types'
import { HistoryIndex } from './index'
import { SessionCwdCache } from './sessionCwdCache'
import { makeDescriptors, type ProviderDescriptor } from '../providers/descriptor'

/** 워처의 디바운스 상한 테스트는 이벤트가 append마다 오는 native 경로에서만 뜻이 있다. chokidar
 *  폴백은 awaitWriteFinish 로 쓰는 중에는 아예 조용하므로(그것이 폴백인 이유이기도 하다) 건너뛴다. */
const nativeRecursiveWatch = ((): boolean => {
  try {
    fsWatch(os.tmpdir(), { recursive: true }, () => {}).close()
    return true
  } catch {
    return false
  }
})()

let tmp: string
let index: HistoryIndex | null = null

function account(id: string): Account {
  return {
    id,
    label: id,
    configDir: path.join(tmp, id),
    color: '#fff',
    createdAt: '2026-07-20T00:00:00Z'
  }
}

async function writeTranscript(acc: Account, slug: string, name: string, sessionId: string): Promise<string> {
  const dir = path.join(acc.configDir, 'projects', slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(
    file,
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd: 'D:\\work\\' + slug,
      message: { role: 'user', content: `${sessionId}의 첫 메시지` }
    }),
    'utf8'
  )
  return file
}

/** 여러 줄(user/assistant 왕복, uuid 등)을 직접 제어해야 하는 테스트용 저수준 헬퍼 */
async function writeLines(acc: Account, slug: string, name: string, lines: unknown[]): Promise<string> {
  const dir = path.join(acc.configDir, 'projects', slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return file
}

const sessionIds = async (req?: Parameters<HistoryIndex['page']>[0]): Promise<string[]> =>
  (await index!.page(req)).entries.map((e) => e.sessionId).sort()

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-history-'))
})

afterEach(async () => {
  await index?.stop()
  index = null
})

describe('HistoryIndex (lazy)', () => {
  it('page()는 여러 계정의 세션을 통합해 돌려준다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    await writeTranscript(b, 'proj-2', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [a, b])
    expect(await sessionIds()).toEqual(['s1', 's2'])
    expect((await index.page({ accountId: 'acc-b' })).entries).toHaveLength(1)
  })

  it('메타 없는 파일은 파일명으로 폴백한다', async () => {
    const a = account('acc-a')
    const dir = path.join(a.configDir, 'projects', 'p')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'broken.jsonl'), 'not-json', 'utf8')
    index = new HistoryIndex(() => [a])
    const { entries } = await index.page()
    expect(entries[0].sessionId).toBe('broken')
    expect(entries[0].title).toBe('broken')
  })

  it('삭제된 파일은 refresh 후 목록에서 빠진다', async () => {
    const a = account('acc-a')
    const file = await writeTranscript(a, 'p', 'gone.jsonl', 'gone')
    index = new HistoryIndex(() => [a])
    expect((await index.page()).entries).toHaveLength(1)
    await fs.rm(file)
    await index.refresh()
    expect((await index.page()).entries).toHaveLength(0)
  })

  it('preview는 해당 transcript만 lazy 파싱한다 (사전 스캔 없이 조회)', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'p', 's.jsonl', 's')
    index = new HistoryIndex(() => [a])
    const preview = await index.preview('acc-a:s')
    expect(preview.entryId).toBe('acc-a:s')
    expect(preview.messages[0].text).toBe('s의 첫 메시지')
  })

  it('워쳐가 새 transcript를 감지해 onUpdated를 발화하고 이후 page에 반영된다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'p', 'first.jsonl', 'first')
    index = new HistoryIndex(() => [a])
    await index.startBackground()
    const updated = vi.fn()
    index.onUpdated = updated
    await writeTranscript(a, 'p', 'second.jsonl', 'second')
    await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })
    expect(await sessionIds()).toEqual(['first', 'second'])
  })

  it.skipIf(!nativeRecursiveWatch)(
    '세션이 계속 append되는 중에도 갱신 알림이 온다 (디바운스 상한)',
    async () => {
      const a = account('acc-a')
      await writeTranscript(a, 'p', 'live.jsonl', 'live')
      index = new HistoryIndex(() => [a])
      await index.startBackground()
      const updated = vi.fn()
      index.onUpdated = updated
      const file = path.join(a.configDir, 'projects', 'p', 'live.jsonl')
      // 150ms 디바운스보다 빠르게 계속 쓴다 — 상한이 없으면 타이머가 무한히 밀려 알림이 안 온다
      let stop = false
      const writing = (async (): Promise<void> => {
        while (!stop) {
          await fs.appendFile(
            file,
            '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'tick' } })
          )
          await new Promise((r) => setTimeout(r, 40))
        }
      })()
      try {
        await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 8000 })
      } finally {
        stop = true
        await writing
      }
    },
    20_000
  )

  it('invalidate 이후에 끝난 빌드는 프로젝트 캐시를 오염시키지 않는다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    await writeTranscript(a, 'proj-a', 's1.jsonl', 's1')
    await writeTranscript(b, 'proj-b', 's2.jsonl', 's2')
    let accounts = [a]
    index = new HistoryIndex(() => accounts)
    // 시작 시점 재현: 첫 projectsPage가 아직 돌고 있는데 ghost 스캔이 끝나 목록이 무효화된다
    const inflight = index.projectsPage()
    await index.refresh()
    accounts = [a, b]
    await inflight
    const { projects } = await index.projectsPage()
    expect(projects.map((p) => p.name).sort()).toEqual(['proj-a', 'proj-b'])
  })

  describe('증분 무효화', () => {
    const projectNames = async (): Promise<string[]> =>
      (await index!.projectsPage()).projects.map((p) => p.name).sort()

    /** 워처가 붙기 직전의 변경까지 흘려보낸다.
     *
     *  macOS 의 FSEvents 는 워치 시작 직전의 변경도 첫 배치로 재생한다(아래 countingDescriptors 의
     *  주석이 그 이유로 관찰을 디스크 상태에서 호출 횟수로 옮겼다). 그런데 **호출 횟수도 오염된다**:
     *  재생된 이벤트는 전량 재읽기를 일으키지는 않지만 폴더 단위 재계산으로는 처리되므로, "어느 폴더가
     *  다시 읽혔나" 에 손대지 않은 프로젝트가 섞인다 — macOS CI 에서 실제로 그렇게 실패했다(dirs 에
     *  proj-b 가 들어왔다).
     *
     *  그래서 재생이 멎을 때까지 기다리고, 남은 pendingDirs 를 한 번의 조회로 소진한 뒤 폴더 계수기만
     *  0 으로 맞춘다. full 은 건드리지 않는다 — 재생은 전량 재읽기를 만들지 않으므로 그 수는 이미 맞고,
     *  지우면 뒤의 "전량 재읽기는 늘지 않았다" 가 무엇과 비교하는지 알 수 없게 된다.
     *
     *  기다림을 고정 시간이 아니라 **활동이 멎는 것**으로 판정한다. 고정 예산은 한가한 머신에서만
     *  충분해서 2코어 CI 러너에서 모자랐던 선례가 있다(main/codexRolling.test.ts 의 settleIo). */
    const drainWatcher = async (dirs: string[]): Promise<void> => {
      let hits = 0
      index!.onUpdated = (): void => {
        hits += 1
      }
      // 조용함의 기준을 넉넉히 잡는다 — 100ms×5 = 0.5초 동안 새 통지가 없어야 재생이 끝난 것으로
      // 본다. 상한은 라운드 수로 센다(최대 6초): 넘으면 기다림이 부족한 것이 아니라 다른 일이다.
      for (let quiet = 0, round = 0; quiet < 5 && round < 60; round += 1) {
        const before = hits
        await new Promise((r) => setTimeout(r, 100))
        quiet = hits === before ? quiet + 1 : 0
      }
      await projectNames() // 재생이 남긴 pendingDirs 를 여기서 소진한다
      dirs.length = 0
    }

    /**
     * descriptors 를 갈아끼워 전략 호출을 센다. 무효화가 부분적이었는지를 **호출 횟수**로 관찰하는
     * 이유는, 디스크 상태로 관찰하려면 "워처를 켜기 전 변경은 이벤트를 내지 않는다"에 기대야 하는데
     * 그것이 플랫폼 의존이기 때문이다 — macOS 는 FSEvents 라 워치 시작 직전의 변경도 재생될 수 있어
     * 리눅스·윈도우에서만 통하는 관찰이었다(실제로 그렇게 CI 가 갈렸다).
     *
     * claude 의 projectSummaries 는 모듈 내부의 projectSummaryForDir 를 직접 부르므로, 여기서 감싼
     * projectSummaryForDir 에는 flushPendingDirs 가 전략을 통해 부른 것만 잡힌다 — 정확히 세고 싶은 것.
     */
    const countingDescriptors = (): {
      descriptors: Record<Provider, ProviderDescriptor>
      full: Record<string, number>
      dirs: string[]
    } => {
      const base = makeDescriptors(process.platform)
      const full: Record<string, number> = {}
      const dirs: string[] = []
      const wrap = (p: Provider): ProviderDescriptor => {
        const h = base[p].history
        const forDir = h.projectSummaryForDir
        return {
          ...base[p],
          history: {
            ...h,
            projectSummaries: (acc, io) => {
              full[p] = (full[p] ?? 0) + 1
              return h.projectSummaries(acc, io)
            },
            ...(forDir
              ? {
                  projectSummaryForDir: (acc, dir, io) => {
                    dirs.push(path.basename(dir))
                    return forDir(acc, dir, io)
                  }
                }
              : {})
          }
        }
      }
      return { descriptors: { claude: wrap('claude'), codex: wrap('codex') }, full, dirs }
    }

    it('파일 하나가 바뀌면 그 프로젝트 폴더만 다시 읽는다', async () => {
      const a = account('acc-a')
      await writeTranscript(a, 'proj-a', 's1.jsonl', 's1')
      await writeTranscript(a, 'proj-b', 's2.jsonl', 's2')
      const { descriptors, full, dirs } = countingDescriptors()
      index = new HistoryIndex(() => [a], descriptors)
      expect(await projectNames()).toEqual(['proj-a', 'proj-b'])
      expect(full.claude).toBe(1) // 최초 1회는 전량

      await index.startBackground()
      await drainWatcher(dirs)
      const updated = vi.fn()
      index.onUpdated = updated
      await writeTranscript(a, 'proj-a', 's3.jsonl', 's3')
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })

      expect(await projectNames()).toEqual(['proj-a', 'proj-b'])
      expect(full.claude).toBe(1) // 전량 재읽기는 늘지 않았다
      expect([...new Set(dirs)]).toEqual(['proj-a']) // 바뀐 폴더만 다시 읽혔다
      expect((await index.page({ projectPath: 'D:\\work\\proj-a' })).entries).toHaveLength(2)

      // 대조군: 전량 무효화는 여전히 전부 다시 읽는다
      await index.refresh()
      await projectNames()
      expect(full.claude).toBe(2)
    })

    it('codex 계정의 이벤트는 그 계정만 무효화한다', async () => {
      const a = account('acc-a')
      const cx: Account = { ...account('cx'), provider: 'codex' }
      await writeTranscript(a, 'proj-a', 's1.jsonl', 's1')
      await writeTranscript(a, 'proj-b', 's2.jsonl', 's2')
      const dir = path.join(cx.configDir, 'sessions', '2026', '07', '09')
      await fs.mkdir(dir, { recursive: true })
      const rollout = path.join(dir, 'rollout-2026-07-09T00-00-00-019f4524-e0ac-7571-a8af-5585504f0d40.jsonl')
      const meta = {
        type: 'session_meta',
        payload: { session_id: '019f4524-e0ac-7571-a8af-5585504f0d40', cwd: 'D:\\proj\\cx' }
      }
      await fs.writeFile(rollout, JSON.stringify(meta) + '\n', 'utf8')
      const { descriptors, full, dirs } = countingDescriptors()
      index = new HistoryIndex(() => [a, cx], descriptors)
      expect(await projectNames()).toEqual(['cx', 'proj-a', 'proj-b'])
      expect(full).toEqual({ claude: 1, codex: 1 })

      await index.startBackground()
      await drainWatcher(dirs)
      const updated = vi.fn()
      index.onUpdated = updated
      await fs.appendFile(rollout, JSON.stringify(meta) + '\n', 'utf8')
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })

      expect(await projectNames()).toEqual(['cx', 'proj-a', 'proj-b'])
      // codex 는 폴더 단위 재계산이 없으니 그 계정만 전량, claude 는 손대지 않았다
      expect(full).toEqual({ claude: 1, codex: 2 })
      expect(dirs).toEqual([])
    })

    it('새 폴더가 생기면 행이 추가된다', async () => {
      const a = account('acc-a')
      await writeTranscript(a, 'proj-a', 's1.jsonl', 's1')
      index = new HistoryIndex(() => [a])
      expect(await projectNames()).toEqual(['proj-a'])
      await index.startBackground()
      const updated = vi.fn()
      index.onUpdated = updated
      await writeTranscript(a, 'proj-new', 's2.jsonl', 's2')
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })
      expect(await projectNames()).toEqual(['proj-a', 'proj-new'])
    })

    it('폴더의 세션이 모두 사라지면 행이 빠진다', async () => {
      const a = account('acc-a')
      await writeTranscript(a, 'proj-a', 's1.jsonl', 's1')
      await writeTranscript(a, 'proj-b', 's2.jsonl', 's2')
      index = new HistoryIndex(() => [a])
      expect(await projectNames()).toEqual(['proj-a', 'proj-b'])
      await index.startBackground()
      const updated = vi.fn()
      index.onUpdated = updated
      await fs.rm(path.join(a.configDir, 'projects', 'proj-b', 's2.jsonl'))
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })
      expect(await projectNames()).toEqual(['proj-a'])
    })

    it('폴더가 대표하는 cwd가 바뀌면 옛 행이 남지 않는다', async () => {
      const a = account('acc-a')
      await writeLines(a, 'moving', 'old.jsonl', [
        { type: 'user', sessionId: 'old', cwd: 'D:\\work\\before', message: { role: 'user', content: '옛 질문' } }
      ])
      index = new HistoryIndex(() => [a])
      expect(await projectNames()).toEqual(['before'])
      await index.startBackground()
      const updated = vi.fn()
      index.onUpdated = updated
      // 같은 폴더에 더 새로운 파일이 다른 cwd로 들어온다 — resolveProjectCwd 는 최신부터 읽는다
      await writeLines(a, 'moving', 'new.jsonl', [
        { type: 'user', sessionId: 'new', cwd: 'D:\\work\\after', message: { role: 'user', content: '새 질문' } }
      ])
      await vi.waitFor(() => expect(updated).toHaveBeenCalled(), { timeout: 5000 })
      expect(await projectNames()).toEqual(['after'])
    })
  })

  it('디렉터리를 .jsonl로 위장해도(파싱 실패) 죽지 않고 제외한다', async () => {
    const a = account('acc-a')
    const dir = path.join(a.configDir, 'projects', 'p')
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(path.join(dir, 'not-a-real-file.jsonl')) // stat은 성공하지만 파싱은 EISDIR로 실패
    index = new HistoryIndex(() => [a])
    await expect(index.page()).resolves.toMatchObject({ total: 0 })
    await expect(index.projectsPage()).resolves.toMatchObject({ total: 0 })
  })

  it('헬퍼(HUD) 세션과 사이드체인 파일은 세션 목록에서 제외된다', async () => {
    const a = account('acc-a')
    const dir = path.join(a.configDir, 'projects', 'p')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'helper.jsonl'),
      JSON.stringify({ type: 'queue-operation', sessionId: 'helper-1' }),
      'utf8'
    )
    await fs.writeFile(
      path.join(dir, 'side.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'side-1',
        cwd: 'D:\\p',
        isSidechain: true,
        message: { role: 'user', content: '사이드체인' }
      }),
      'utf8'
    )
    await writeTranscript(a, 'p', 'normal.jsonl', 'normal-1')
    index = new HistoryIndex(() => [a])
    expect(await sessionIds()).toEqual(['normal-1'])
  })

  it('노이즈(헬퍼)만 있는 폴더는 프로젝트 목록에 뜨지 않는다', async () => {
    const a = account('acc-a')
    const dir = path.join(a.configDir, 'projects', 'noise-only')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'h.jsonl'),
      JSON.stringify({ type: 'ai-title', sessionId: 'h-1' }),
      'utf8'
    )
    await writeTranscript(a, 'real', 'r.jsonl', 'r-1')
    index = new HistoryIndex(() => [a])
    const { projects } = await index.projectsPage()
    expect(projects.map((p) => p.name)).toEqual(['real'])
  })

  it('page()는 offset/limit로 슬라이스하고 total을 돌려준다', async () => {
    const a = account('acc-a')
    for (let i = 0; i < 5; i++) await writeTranscript(a, 'p', `s${i}.jsonl`, `s${i}`)
    index = new HistoryIndex(() => [a])
    const p1 = await index.page({ offset: 0, limit: 2 })
    expect(p1.entries).toHaveLength(2)
    expect(p1.total).toBe(5)
    const p2 = await index.page({ offset: 2, limit: 2 })
    expect(p2.entries.map((e) => e.id)).not.toEqual(p1.entries.map((e) => e.id))
    expect((await index.page({ offset: 4, limit: 2 })).entries).toHaveLength(1)
    const withDefaults = await index.page()
    expect(withDefaults.entries).toHaveLength(5) // 기본 offset=0, limit=50
    expect((await index.page({ accountId: 'nonexistent' })).total).toBe(0)
  })

  it('projectsPage()는 폴더를 최근활동순으로 요약한다 (이름=실제 cwd 마지막 세그먼트)', async () => {
    const a = account('acc-a')
    const fa1 = await writeTranscript(a, 'proj-a', 'a1.jsonl', 'a1')
    const fa2 = await writeTranscript(a, 'proj-a', 'a2.jsonl', 'a2')
    const fb1 = await writeTranscript(a, 'proj-b', 'b1.jsonl', 'b1')
    // 결정적 정렬: proj-b(3000)가 proj-a(최신 2000)보다 최근
    await fs.utimes(fa1, new Date(1000), new Date(1000))
    await fs.utimes(fa2, new Date(2000), new Date(2000))
    await fs.utimes(fb1, new Date(3000), new Date(3000))
    index = new HistoryIndex(() => [a])
    const { projects, total } = await index.projectsPage()
    expect(total).toBe(2)
    expect(projects.map((p) => p.projectPath)).toEqual(['D:\\work\\proj-b', 'D:\\work\\proj-a'])
    expect(projects.map((p) => p.name)).toEqual(['proj-b', 'proj-a'])
    expect(projects[0].accountId).toBe('acc-a')
    // proj-a의 updatedAt은 그 폴더 최신 파일(a2=2000)
    expect(projects[1].updatedAt).toBe(new Date(2000).toISOString())
  })

  it('projectsPage()는 offset/limit 페이징과 accountId 필터를 지원한다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    const files: string[] = []
    for (const s of ['pa', 'pb', 'pc']) files.push(await writeTranscript(a, s, s + '.jsonl', s))
    files.push(await writeTranscript(b, 'pd', 'pd.jsonl', 'pd'))
    let t = 1000
    for (const f of files) {
      await fs.utimes(f, new Date(t), new Date(t))
      t += 1000
    }
    index = new HistoryIndex(() => [a, b])
    expect((await index.projectsPage()).total).toBe(4)
    const p1 = await index.projectsPage({ offset: 0, limit: 2 })
    expect(p1.projects).toHaveLength(2)
    expect(p1.total).toBe(4)
    const p2 = await index.projectsPage({ offset: 2, limit: 2 })
    expect(p2.projects.map((p) => p.projectPath)).not.toEqual(p1.projects.map((p) => p.projectPath))
    const onlyA = await index.projectsPage({ accountId: 'acc-a' })
    expect(onlyA.total).toBe(3)
    expect(onlyA.projects.every((p) => p.name !== 'pd')).toBe(true)
  })

  /** 등록 해제된 계정: id 만 ghostAccounts()가 만드는 모양이고 configDir 은 평범한 폴더다 */
  const ghost = (dirName: string): Account => ({
    ...account(dirName),
    id: 'ghost:' + path.join(tmp, dirName).toLowerCase()
  })

  it('ghost 소스(등록 해제된 계정)의 프로젝트와 세션도 목록에 포함된다', async () => {
    // 등록 해제해도 transcript 는 디스크에 남는다 — 사이드바에서 사라지면 안 된다
    const live = account('acc-live')
    const gone = ghost('gone-dir')
    await writeTranscript(live, 'proj-live', 's1.jsonl', 's1')
    await writeTranscript(gone, 'proj-gone', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [live, gone])

    const projects = (await index.projectsPage()).projects.map((p) => p.projectPath)
    expect(projects.some((p) => p.endsWith('proj-gone'))).toBe(true)
    expect(await sessionIds()).toEqual(['s1', 's2'])
  })

  it('ghost 소스의 entryId로 preview가 동작한다', async () => {
    const gone = ghost('gone-dir')
    await writeTranscript(gone, 'proj-gone', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [gone])
    const entry = (await index.page()).entries[0]
    expect(entry.accountId).toBe(gone.id)
    const preview = await index.preview(entry.id)
    expect(preview.messages.length).toBeGreaterThan(0)
  })

  it('등록 계정과 ghost가 같은 cwd를 가지면 프로젝트 행이 하나로 합쳐진다', async () => {
    // 해제 전후로 같은 폴더에서 작업했으면 행이 둘로 갈라지면 안 된다
    const live = account('acc-live')
    const gone = ghost('gone-dir')
    await writeTranscript(live, 'shared', 's1.jsonl', 's1')
    await writeTranscript(gone, 'shared', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [live, gone])
    const page = await index.projectsPage()
    expect(page.total).toBe(1)
  })

  it('projectsPage()는 hiddenPaths의 프로젝트를 목록과 total에서 함께 제외한다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    await writeTranscript(a, 'proj-2', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [a])

    const before = await index.projectsPage()
    expect(before.total).toBe(2)
    // 경로 표기를 문자열로 가정하지 않기 위해 실제 결과에서 대상을 고른다
    const target = before.projects.find((p) => p.projectPath.endsWith('proj-1'))!

    const after = await index.projectsPage({ hiddenPaths: [target.projectPath] })
    expect(after.projects.map((p) => p.projectPath.endsWith('proj-2'))).toEqual([true])
    // total도 줄어야 한다 — 아니면 렌더러의 무한 스크롤 sentinel이 영구히 남는다
    expect(after.total).toBe(1)
  })

  it('projectsPage()의 hiddenPaths는 대소문자·구분자 표기가 달라도 같은 프로젝트로 본다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    index = new HistoryIndex(() => [a])

    const target = (await index.projectsPage()).projects[0].projectPath
    const shouted = await index.projectsPage({ hiddenPaths: [target.toUpperCase()] })
    expect(shouted.total).toBe(0)

    // 구분자 바꿔치기는 win32에서만 같은 경로다. POSIX에서 `\`는 이름에 쓸 수 있는 글자라, 슬래시로
    // 바꾼 문자열은 같은 경로가 아니라 아예 다른 경로가 된다
    if (process.platform === 'win32') {
      const slashed = await index.projectsPage({ hiddenPaths: [target.replace(/\\/g, '/')] })
      expect(slashed.total).toBe(0)
    }
  })

  it('projectsPage()는 hiddenPaths가 없거나 비어도 기존 동작을 유지한다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    index = new HistoryIndex(() => [a])

    expect((await index.projectsPage()).total).toBe(1)
    expect((await index.projectsPage({ hiddenPaths: [] })).total).toBe(1)
  })

  // 이름은 "한 페이지가 전부 숨겨져도"였지만, 필터가 슬라이스보다 먼저 메인 프로세스에서 실행되므로
  // 숨긴 항목이 포함된 페이지 자체가 만들어질 수 없다 — 이 테스트가 실제로 검증하는 것은 hide로
  // 목록이 줄어든 뒤 뒤따르는 offset들이 밀리지 않고 앞으로 당겨진다는 점이다.
  it('projectsPage()는 hide로 총 개수가 줄면 이후 offset이 앞으로 당겨진다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    await writeTranscript(a, 'proj-2', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [a])

    const all = (await index.projectsPage()).projects
    const first = await index.projectsPage({ hiddenPaths: [all[0].projectPath], offset: 0, limit: 1 })
    // 숨긴 것이 목록에서 빠졌으므로 첫 페이지에 두 번째 프로젝트가 온다
    expect(first.projects).toHaveLength(1)
    expect(first.projects[0].projectPath).toBe(all[1].projectPath)
    expect(first.total).toBe(1)
  })

  it('projectsPage()는 accountId 필터와 hiddenPaths를 함께 적용한다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    await writeTranscript(a, 'proj-2', 's2.jsonl', 's2')
    await writeTranscript(b, 'proj-3', 's3.jsonl', 's3')
    index = new HistoryIndex(() => [a, b])

    const all = (await index.projectsPage()).projects
    const hideMe = all.find((p) => p.projectPath.endsWith('proj-1'))!
    const r = await index.projectsPage({ accountId: 'acc-a', hiddenPaths: [hideMe.projectPath] })
    expect(r.total).toBe(1)
    expect(r.projects[0].projectPath.endsWith('proj-2')).toBe(true)
  })

  it('같은 폴더를 여러 계정에서 쓰면 프로젝트 목록엔 1행으로 병합된다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    // 두 계정 모두 동일 cwd(D:\work\shared)의 세션 — writeTranscript는 cwd='D:\\work\\'+slug
    const fa = await writeTranscript(a, 'shared', 'a1.jsonl', 'a1')
    const fb = await writeTranscript(b, 'shared', 'b1.jsonl', 'b1')
    await fs.utimes(fa, new Date(1000), new Date(1000))
    await fs.utimes(fb, new Date(2000), new Date(2000)) // b가 최신
    index = new HistoryIndex(() => [a, b])
    const { projects, total } = await index.projectsPage()
    expect(total).toBe(1)
    expect(projects).toHaveLength(1)
    expect(projects[0].projectPath).toBe('D:\\work\\shared')
    expect(projects[0].updatedAt).toBe(new Date(2000).toISOString()) // 최신 대표
    // 계정 필터 시엔 해당 계정만
    expect((await index.projectsPage({ accountId: 'acc-a' })).total).toBe(1)
    // 펼치면 두 계정 세션이 함께 (통합 뷰 유지)
    expect((await index.page({ projectPath: 'D:\\work\\shared' })).entries.map((e) => e.sessionId).sort()).toEqual(['a1', 'b1'])
  })

  it('page({projectPath})는 그 프로젝트의 세션만 돌려준다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'proj-a', 'a1.jsonl', 'a1')
    await writeTranscript(a, 'proj-b', 'b1.jsonl', 'b1')
    index = new HistoryIndex(() => [a])
    const { entries } = await index.page({ projectPath: 'D:\\work\\proj-a' })
    expect(entries.map((e) => e.sessionId)).toEqual(['a1'])
  })

  it('title은 마지막 real user 메시지를 쓴다 (assistant 답장 이후에도)', async () => {
    const a = account('acc-a')
    await writeLines(a, 'p', 'multi.jsonl', [
      { type: 'user', sessionId: 'multi', cwd: 'D:\\work\\p', message: { role: 'user', content: '첫 메시지' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변1' }] } },
      { type: 'user', message: { role: 'user', content: '마지막 메시지' } }
    ])
    index = new HistoryIndex(() => [a])
    expect((await index.page()).entries[0].title).toBe('마지막 메시지')
  })

  it('마지막 의미 메시지가 assistant면 awaitingReply=true', async () => {
    const a = account('acc-a')
    await writeLines(a, 'p', 'wait.jsonl', [
      { type: 'user', sessionId: 'wait', cwd: 'D:\\work\\p', message: { role: 'user', content: '질문' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } }
    ])
    index = new HistoryIndex(() => [a])
    expect((await index.page()).entries[0].awaitingReply).toBe(true)
  })

  it('마지막 의미 메시지가 user면 awaitingReply=false', async () => {
    const a = account('acc-a')
    await writeLines(a, 'p', 'nowait.jsonl', [
      { type: 'user', sessionId: 'nowait', cwd: 'D:\\work\\p', message: { role: 'user', content: '질문' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '답변' }] } },
      { type: 'user', message: { role: 'user', content: '추가 질문' } }
    ])
    index = new HistoryIndex(() => [a])
    expect((await index.page()).entries[0].awaitingReply).toBe(false)
  })

  it('동일 rootUuid(resume 포크) 2파일은 최신 1개만 남는다', async () => {
    const a = account('acc-a')
    const f1 = await writeLines(a, 'p', 'fork1.jsonl', [
      { type: 'user', sessionId: 'fork1', cwd: 'D:\\work\\p', uuid: 'root-x', message: { role: 'user', content: '원본' } }
    ])
    const f2 = await writeLines(a, 'p', 'fork2.jsonl', [
      { type: 'user', sessionId: 'fork2', cwd: 'D:\\work\\p', uuid: 'root-x', message: { role: 'user', content: '포크' } }
    ])
    await fs.utimes(f1, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    await fs.utimes(f2, new Date(), new Date())
    index = new HistoryIndex(() => [a])
    const { entries, total } = await index.page()
    expect(total).toBe(1)
    expect(entries[0].sessionId).toBe('fork2')
  })

  it('rootUuid가 null인 파일들은 그룹핑 대상이 아니라 각각 유지된다', async () => {
    const a = account('acc-a')
    await writeTranscript(a, 'p', 'n1.jsonl', 'n1')
    await writeTranscript(a, 'p', 'n2.jsonl', 'n2')
    index = new HistoryIndex(() => [a])
    expect(await sessionIds()).toEqual(['n1', 'n2'])
  })

  it('롤링 사본(여러 계정의 같은 sessionId)은 최신 파일 하나만 남긴다', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    const fa = await writeTranscript(a, 'proj', 's-roll.jsonl', 's-roll')
    const fb = await writeTranscript(b, 'proj', 's-roll.jsonl', 's-roll')
    const older = new Date('2026-07-22T01:00:00Z')
    const newer = new Date('2026-07-22T02:00:00Z')
    await fs.utimes(fa, older, older)
    await fs.utimes(fb, newer, newer)
    index = new HistoryIndex(() => [a, b])
    const { entries, total } = await index.page()
    expect(total).toBe(1)
    expect(entries[0].accountId).toBe('acc-b') // 최신 파일(라이브 쪽)이 대표
  })

  it('knownProjectPaths는 전 계정 프로젝트 경로 목록을 돌려준다 (가드용)', async () => {
    const a = account('acc-a')
    const b = account('acc-b')
    await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
    await writeTranscript(b, 'proj-2', 's2.jsonl', 's2')
    index = new HistoryIndex(() => [a, b])
    const paths = await index.knownProjectPaths()
    expect(paths.sort()).toEqual(['D:\\work\\proj-1', 'D:\\work\\proj-2'])
  })

  describe('codex 계정', () => {
    function codexAccount(id: string): Account {
      return { ...account(id), provider: 'codex' }
    }

    /** codex는 <configDir>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl 구조 */
    async function writeRollout(
      acc: Account,
      uuid: string,
      cwd: string | null,
      lines: unknown[] = []
    ): Promise<string> {
      const dir = path.join(acc.configDir, 'sessions', '2026', '07', '09')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `rollout-2026-07-09T00-00-00-${uuid}.jsonl`)
      const meta = {
        type: 'session_meta',
        payload: cwd === null ? { session_id: uuid } : { session_id: uuid, cwd }
      }
      await fs.writeFile(file, [meta, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      return file
    }

    const cxUser = (t: string): unknown => ({
      timestamp: '2026-07-09T01:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: t }
    })

    it('codex 계정의 rollout이 프로젝트·세션 목록에 나타난다', async () => {
      const cx = codexAccount('cx1')
      await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d32', 'D:\\proj\\alpha', [cxUser('알파 질문')])
      index = new HistoryIndex(() => [cx])
      const { projects } = await index.projectsPage()
      expect(projects.map((p) => p.projectPath)).toEqual(['D:\\proj\\alpha'])
      const { entries } = await index.page({ projectPath: 'D:\\proj\\alpha' })
      expect(entries).toHaveLength(1)
      expect(entries[0].sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d32')
      expect(entries[0].title).toBe('알파 질문')
      expect(entries[0].rootUuid).toBeNull()
    })

    it('cwd 없는 rollout(비대화 기록)은 목록에서 제외된다', async () => {
      const cx = codexAccount('cx2')
      await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d33', null)
      index = new HistoryIndex(() => [cx])
      expect((await index.projectsPage()).projects).toEqual([])
    })

    it('codex 항목의 preview는 codex 파서로 읽는다', async () => {
      const cx = codexAccount('cx3')
      await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d34', 'D:\\proj\\beta', [cxUser('베타 질문')])
      index = new HistoryIndex(() => [cx])
      const { entries } = await index.page()
      const preview = await index.preview(entries[0].id)
      expect(preview.messages).toEqual([
        { role: 'user', text: '베타 질문', timestamp: '2026-07-09T01:00:00Z' }
      ])
    })

    it('cwd 메모가 히트하면 rollout 파일을 다시 읽지 않는다', async () => {
      const cx = codexAccount('cx-memo')
      const file = await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d36', 'D:\\proj\\ondisk', [
        cxUser('질문')
      ])
      const st = await fs.stat(file)
      const cache = new SessionCwdCache(path.join(tmp, 'session-cwd.json'))
      await cache.load()
      // 파일 내용과 **다른** cwd를 심는다 — 목록에 이것이 나오면 파일을 열지 않았다는 뜻이다
      cache.set(file, st.mtimeMs, st.size, 'D:\\proj\\memoized')
      index = new HistoryIndex(() => [cx], undefined, cache)
      const { projects } = await index.projectsPage()
      expect(projects.map((p) => p.projectPath)).toEqual(['D:\\proj\\memoized'])
    })

    it('메모가 없거나 (mtime,size)가 어긋나면 다시 읽고 결과를 메모에 남긴다', async () => {
      const cx = codexAccount('cx-memo2')
      const file = await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d37', 'D:\\proj\\ondisk', [
        cxUser('질문')
      ])
      const st = await fs.stat(file)
      const cache = new SessionCwdCache(path.join(tmp, 'session-cwd.json'))
      await cache.load()
      cache.set(file, st.mtimeMs, st.size + 1, 'D:\\proj\\stale') // size 어긋남 = miss
      index = new HistoryIndex(() => [cx], undefined, cache)
      const { projects } = await index.projectsPage()
      expect(projects.map((p) => p.projectPath)).toEqual(['D:\\proj\\ondisk'])
      expect(cache.get(file, st.mtimeMs, st.size)).toBe('D:\\proj\\ondisk')
    })

    it('메모를 써도 프로젝트를 펼치면 세션이 정상적으로 파싱된다', async () => {
      const cx = codexAccount('cx-memo3')
      const file = await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d38', 'D:\\proj\\delta', [
        cxUser('델타 질문')
      ])
      const st = await fs.stat(file)
      const cache = new SessionCwdCache(path.join(tmp, 'session-cwd.json'))
      await cache.load()
      cache.set(file, st.mtimeMs, st.size, 'D:\\proj\\delta')
      index = new HistoryIndex(() => [cx], undefined, cache)
      await index.projectsPage()
      const { entries } = await index.page({ projectPath: 'D:\\proj\\delta' })
      expect(entries).toHaveLength(1)
      expect(entries[0].title).toBe('델타 질문')
    })

    it('claude 계정과 섞여도 각자의 파서·경로로 통합된다', async () => {
      const a = account('acc-a')
      const cx = codexAccount('cx4')
      await writeTranscript(a, 'proj-1', 's1.jsonl', 's1')
      await writeRollout(cx, '019f4524-e0ac-7571-a8af-5585504f0d35', 'D:\\proj\\gamma', [cxUser('감마 질문')])
      index = new HistoryIndex(() => [a, cx])
      expect(await sessionIds()).toEqual(['019f4524-e0ac-7571-a8af-5585504f0d35', 's1'].sort())
    })
  })
})
