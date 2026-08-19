import { describe, it, expect, afterEach } from 'vitest'
import type { TestContext } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalHistoryStore } from './store'
import { MAX_AGE_MS, MAX_TOTAL_BYTES, TOO_LARGE_BYTES, projectKey, normalizeProjectPath } from '../files/localHistory'

// 실제 임시 디렉터리를 만들어 fs를 그대로 태운다 — src/core/worktrees/include.test.ts의 dirSize
// 테스트와 같은 방식. 각 테스트가 만든 디렉터리는 afterEach에서 정리한다.
const dirs: string[] = []
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

/** symlink 생성 실패가 권한 문제(EPERM/EACCES)면 실패가 아니라 스킵으로 처리한다 —
 *  worktrees/include.test.ts의 trySymlink와 같은 이유(Windows는 보통 관리자 권한/Developer
 *  Mode가 있어야 symlink를 만들 수 있다). */
async function trySymlink(ctx: TestContext, target: string, linkPath: string, type: 'file' | 'dir'): Promise<void> {
  try {
    await fs.symlink(target, linkPath, type)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      ctx.skip(`symlink 생성 권한 없음(${code}) — 이 환경은 관리자 권한/Developer Mode가 없습니다`)
    }
    throw err
  }
}

describe('LocalHistoryStore.load', () => {
  it('index.json이 없으면(ENOENT) 빈 상태로 시작한다', async () => {
    const root = await tmp('astera-lh-load-enoent-')
    const store = new LocalHistoryStore(path.join(root, 'local-history'))
    const r = await store.load()
    expect(r.recovered).toBe(false)
    expect(store.list('C:\\proj')).toEqual([])
  })

  it('손상된 index.json은 .bak으로 보존 후 빈 상태로 시작한다 (recovered: true)', async () => {
    const root = await tmp('astera-lh-load-corrupt-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(path.join(historyDir, 'index.json'), '{ not json', 'utf8')
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.list('C:\\proj')).toEqual([])
    const bak = await fs.readFile(path.join(historyDir, 'index.json.bak'), 'utf8')
    expect(bak).toBe('{ not json')
  })

  it('스키마가 어긋난 index.json(entry에 필수 필드 누락)도 손상으로 취급한다', async () => {
    const root = await tmp('astera-lh-load-badschema-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(
      path.join(historyDir, 'index.json'),
      JSON.stringify({ 'c:\\proj': [{ id: 'x' }] }),
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
  })

  it('id에 경로 구분자·..가 있으면 손상으로 취급한다 (I-5, id 경유 저장소 밖 우회 방지)', async () => {
    const root = await tmp('astera-lh-load-badid-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(
      path.join(historyDir, 'index.json'),
      JSON.stringify({
        'c:\\proj': [{ id: '..\\..\\..\\secret', originalPath: 'c:/proj/x.txt', deletedAt: 1, size: 1, isDir: false }]
      }),
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.list('c:\\proj')).toEqual([])
  })

  it('size가 무한(1e400)이면 손상으로 취급한다 (I-6, 비유한 size가 전체 이력을 축출시키는 사고 방지)', async () => {
    const root = await tmp('astera-lh-load-infsize-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    // JSON.parse('1e400')는 유효한 JSON 수치 리터럴이 오버플로해 Infinity가 된다 —
    // JSON.stringify로는 만들 수 없어 원문을 직접 쓴다.
    await fs.writeFile(
      path.join(historyDir, 'index.json'),
      '{"c:\\\\proj":[{"id":"1-x.txt","originalPath":"c:/proj/x.txt","deletedAt":1,"size":1e400,"isDir":false}]}',
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.list('c:\\proj')).toEqual([])
  })

  it('size가 음수면 손상으로 취급한다 (I-6, 음수는 유한해 Number.isFinite만으론 못 막는다)', async () => {
    const root = await tmp('astera-lh-load-negsize-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(
      path.join(historyDir, 'index.json'),
      JSON.stringify({
        'c:\\proj': [{ id: '1-x.txt', originalPath: 'c:/proj/x.txt', deletedAt: 1, size: -1, isDir: false }]
      }),
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.list('c:\\proj')).toEqual([])
  })

  it('deletedAt이 무한(1e400)이면 손상으로 취급한다 (selectEvictions의 나이·정렬 판정을 지킨다)', async () => {
    const root = await tmp('astera-lh-load-infdeletedat-')
    const historyDir = path.join(root, 'local-history')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(
      path.join(historyDir, 'index.json'),
      '{"c:\\\\proj":[{"id":"1-x.txt","originalPath":"c:/proj/x.txt","deletedAt":1e400,"size":1,"isDir":false}]}',
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.list('c:\\proj')).toEqual([])
  })

  it('정상 index.json은 그대로 불러온다 (recovered: false)', async () => {
    const root = await tmp('astera-lh-load-ok-')
    const historyDir = path.join(root, 'local-history')
    const store1 = new LocalHistoryStore(historyDir)
    await store1.load()
    const projDir = await tmp('astera-lh-load-ok-proj-')
    await fs.writeFile(path.join(projDir, 'a.txt'), 'hello', 'utf8')
    await store1.snapshot(projDir, path.join(projDir, 'a.txt'), false)

    const store2 = new LocalHistoryStore(historyDir)
    const r = await store2.load()
    expect(r.recovered).toBe(false)
    expect(store2.list(projDir).length).toBe(1)
  })
})

describe('LocalHistoryStore.snapshot', () => {
  it('50MB 초과 크기(실제 디스크 사용량)는 아무것도 쓰지 않고 null을 돌려준다', async () => {
    const root = await tmp('astera-lh-snap-toolarge-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-toolarge-proj-')
    const target = path.join(projDir, 'huge.bin')
    // snapshot()이 이제 크기를 스스로 재므로(수정4), 판정을 재현하려면 실제로 50MB를 넘는
    // 내용이 있어야 한다 — size를 인자로 속일 수 없다.
    await fs.writeFile(target, Buffer.alloc(TOO_LARGE_BYTES + 1))
    const entry = await store.snapshot(projDir, target, false)
    expect(entry).toBeNull()
    expect(store.list(projDir)).toEqual([])
    // 저장소 디렉터리 자체가 생기지 않았거나, 생겼어도 안이 비어 있어야 한다
    await expect(fs.access(path.join(historyDir, 'index.json'))).rejects.toThrow()
  })

  it(
    '심볼릭 링크는 대상을 따라가지 않고 링크 자신의 크기만 센다 (I-4, dereference 기준이면 거짓 too-large가 난다)',
    async (ctx) => {
      const root = await tmp('astera-lh-snap-symlink-')
      const historyDir = path.join(root, 'local-history')
      const store = new LocalHistoryStore(historyDir)
      await store.load()
      const projDir = await tmp('astera-lh-snap-symlink-proj-')
      // 실체는 50MB 상한을 넘는 큰 파일이지만, 삭제 대상 폴더 안에는 그걸 가리키는 심볼릭
      // 링크만 있다 — fs.cp(dereference:false 기본값)는 이 링크를 그대로(작게) 복사하므로,
      // 크기 판정도 실체가 아니라 링크 자신 기준이어야 한다.
      const bigTarget = await tmp('astera-lh-snap-symlink-big-')
      const bigFile = path.join(bigTarget, 'real.bin')
      await fs.writeFile(bigFile, Buffer.alloc(TOO_LARGE_BYTES + 1))
      const folder = path.join(projDir, 'folder')
      await fs.mkdir(folder)
      await trySymlink(ctx, bigFile, path.join(folder, 'link.bin'), 'file')

      const entry = await store.snapshot(projDir, folder, true)
      expect(entry).not.toBeNull() // dereference 기준이었다면 too-large로 null이 됐을 것
      expect(entry!.size).toBeLessThan(1024) // 링크 자신의 크기(경로 문자열 길이 수준)만 집계
    }
  )

  it('파일을 스냅샷하면 내용이 복사되고 index.json에 원자적으로 반영된다', async () => {
    const root = await tmp('astera-lh-snap-file-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-file-proj-')
    const target = path.join(projDir, 'note.txt')
    await fs.writeFile(target, 'contents-here', 'utf8')

    const entry = await store.snapshot(projDir, target, false)
    expect(entry).not.toBeNull()
    expect(entry!.originalPath).toBe(target)
    expect(entry!.isDir).toBe(false)
    expect(entry!.size).toBe(Buffer.byteLength('contents-here')) // 이제 store가 직접 재므로 실제 바이트와 일치
    expect(store.list(projDir)).toEqual([entry])

    // .tmp가 남지 않고 index.json만 남아야 한다 (원자적 쓰기, registry.ts 의 AccountRegistry.save와 같은 규약)
    const files = await fs.readdir(historyDir)
    expect(files).toContain('index.json')
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)

    // 실제로 파일 내용이 저장소 디렉터리에 복사돼 있어야 한다
    const onDisk = JSON.parse(await fs.readFile(path.join(historyDir, 'index.json'), 'utf8'))
    const keys = Object.keys(onDisk)
    expect(keys.length).toBe(1)
    expect(onDisk[keys[0]][0].id).toBe(entry!.id)
  })

  it('폴더를 스냅샷하면 하위 내용까지 재귀 복사된다', async () => {
    const root = await tmp('astera-lh-snap-dir-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-dir-proj-')
    const target = path.join(projDir, 'sub')
    await fs.mkdir(path.join(target, 'nested'), { recursive: true })
    await fs.writeFile(path.join(target, 'nested', 'f.txt'), 'deep', 'utf8')

    const entry = await store.snapshot(projDir, target, true)
    expect(entry).not.toBeNull()
    expect(entry!.isDir).toBe(true)
    expect(entry!.size).toBe(Buffer.byteLength('deep'))

    const projHash = (await fs.readdir(historyDir)).find((n) => n !== 'index.json')
    expect(projHash).toBeDefined()
    const copied = await fs.readFile(
      path.join(historyDir, projHash!, entry!.id, 'sub', 'nested', 'f.txt'),
      'utf8'
    )
    expect(copied).toBe('deep')
  })

  it('스냅샷 실패(대상 없음)는 예외를 던진다 — files.remove가 그 예외로 "실패" 판단을 내린다', async () => {
    const root = await tmp('astera-lh-snap-fail-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-fail-proj-')
    const missing = path.join(projDir, 'gone.txt') // 실제로 만들지 않음
    await expect(store.snapshot(projDir, missing, false)).rejects.toThrow()
  })

  it('보관 정책 — 기간 초과 항목은 다음 snapshot() 때 디스크·index.json에서 함께 축출된다', async () => {
    const root = await tmp('astera-lh-snap-evict-age-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-evict-age-proj-')

    const oldTarget = path.join(projDir, 'old.txt')
    await fs.writeFile(oldTarget, 'old', 'utf8')
    const oldEntry = await store.snapshot(projDir, oldTarget, false)
    expect(oldEntry).not.toBeNull()

    // index.json을 직접 열어 deletedAt을 보관 기간보다 오래 전으로 되돌린다 (Date.now() 목없이
    // 기간 초과를 재현하는 유일한 방법 — store는 시계를 주입받지 않는다)
    const idxPath = path.join(historyDir, 'index.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf8'))
    const key = Object.keys(idx)[0]
    idx[key][0].deletedAt = Date.now() - MAX_AGE_MS - 1000
    await fs.writeFile(idxPath, JSON.stringify(idx), 'utf8')
    await store.load() // 방금 손으로 고친 index.json을 다시 읽어 인메모리에 반영

    const projHash = (await fs.readdir(historyDir)).find((n) => n !== 'index.json')!
    const oldSnapDir = path.join(historyDir, projHash, oldEntry!.id)
    await expect(fs.access(oldSnapDir)).resolves.toBeUndefined() // 축출 전에는 존재

    const newTarget = path.join(projDir, 'new.txt')
    await fs.writeFile(newTarget, 'new', 'utf8')
    await store.snapshot(projDir, newTarget, false) // 이 호출이 축출을 트리거한다

    const list = store.list(projDir)
    expect(list.find((e) => e.id === oldEntry!.id)).toBeUndefined() // index.json에서 빠짐
    await expect(fs.access(oldSnapDir)).rejects.toThrow() // 디스크에서도 빠짐
  })

  it('보관 정책 — 총량(200MB) 초과 시 오래된 것부터 축출된다', async () => {
    const root = await tmp('astera-lh-snap-evict-size-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-snap-evict-size-proj-')

    // snapshot()이 이제 크기를 실제 디스크 사용량으로 직접 재므로(수정4), size를 인자로 속여
    // 200MB를 재현할 수 없다 — 대신 나이 기반 축출 테스트와 같은 기법으로 index.json을 직접
    // 고쳐 이미 기록된 항목들의 size를 부풀린다. 실제 파일은 몇 바이트씩만 쓴다.
    // 단일 항목 상한(TOO_LARGE_BYTES)을 넘지 않게 정확히 MAX_TOTAL_BYTES/4씩 4개를 부풀리면
    // 딱 한도(200MB) — 아직 초과가 아니다. 5번째(실제로 몇 바이트뿐인) 항목이 더해지는 순간
    // 한도를 넘겨, selectEvictions가 가장 오래된 것 하나만 빼면 다시 한도 안에 들어온다는 걸
    // 검증할 수 있다.
    const each = MAX_TOTAL_BYTES / 4
    const entries: Array<{ id: string }> = []
    for (let i = 0; i < 4; i++) {
      const t = path.join(projDir, `f${i}.txt`)
      await fs.writeFile(t, String(i), 'utf8')
      entries.push((await store.snapshot(projDir, t, false))!)
    }
    const idxPath = path.join(historyDir, 'index.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf8'))
    const key = Object.keys(idx)[0]
    for (const e of idx[key]) e.size = each
    await fs.writeFile(idxPath, JSON.stringify(idx), 'utf8')
    await store.load() // 부풀린 크기를 인메모리에 반영
    expect(store.list(projDir).length).toBe(4) // 딱 한도(200MB) — 아직 초과가 아니라 전부 남는다

    const t5 = path.join(projDir, 'f4.txt')
    await fs.writeFile(t5, '4', 'utf8')
    const e5 = (await store.snapshot(projDir, t5, false))! // 몇 바이트뿐이라도 한도를 넘겨 축출을 트리거한다

    const list = store.list(projDir)
    const ids = list.map((e) => e.id).sort()
    expect(ids).toEqual([entries[1].id, entries[2].id, entries[3].id, e5.id].sort()) // 가장 오래된 entries[0]만 빠짐
    const projHash = (await fs.readdir(historyDir)).find((n) => n !== 'index.json')!
    await expect(fs.access(path.join(historyDir, projHash, entries[0].id))).rejects.toThrow()
    await expect(fs.access(path.join(historyDir, projHash, entries[1].id))).resolves.toBeUndefined()
  })
})

describe('LocalHistoryStore.list — 프로젝트 간 이력 격리', () => {
  it('다른 프로젝트의 항목은 보이지 않는다 (기본 케이스 — 해시도 우연히 다른 두 프로젝트)', async () => {
    const root = await tmp('astera-lh-list-isolation-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projA = await tmp('astera-lh-list-isolation-a-')
    const projB = await tmp('astera-lh-list-isolation-b-')

    const fa = path.join(projA, 'a.txt')
    await fs.writeFile(fa, 'a', 'utf8')
    await store.snapshot(projA, fa, false)

    const fb = path.join(projB, 'b.txt')
    await fs.writeFile(fb, 'b', 'utf8')
    await store.snapshot(projB, fb, false)

    expect(store.list(projA).length).toBe(1)
    expect(store.list(projB).length).toBe(1)
    expect(store.list(projA)[0].originalPath).toBe(fa)
    expect(store.list(projB)[0].originalPath).toBe(fb)
    // A를 지운 뒤 B의 이력을 열어도 A 항목이 보이지 않아야 한다(브리프 안전성 추적 ④)
    expect(store.list(projB).some((e) => e.originalPath === fa)).toBe(false)
    // 이 테스트는 mkdtemp의 무작위 접미사에 의존해 projA·projB의 projectKey(해시)도 우연히
    // 다르다 — 그래서 list()가 해시로 걸렀어도 통과했을 것이다. 진짜 불변식 ④(해시가 같아도
    // 안 섞인다)는 바로 아래 "해시가 충돌하는" 테스트가 검증한다 (리뷰 지적).
  })

  it('projectKey(디스크 해시)가 충돌하는 두 프로젝트도 list()가 정규화 경로로 분리한다 (불변식 ④)', async () => {
    // 브루트포스로 찾은 실제 충돌 쌍(FNV-1a 32비트, node -e로 300만개 스캔해 발견) — projectKey는
    // 같지만 normalizeProjectPath(=index.json 키)는 다르다. mkdtemp 경로는 무작위 접미사라 사실상
    // 절대 충돌하지 않으므로, 이렇게 미리 찾아 둔 고정 쌍이 아니면 이 불변식을 실제로 재현할 수
    // 없다. 전제(진짜 충돌인지)는 아래에서 직접 단정한다 — projectKey 알고리즘이
    // 나중에 바뀌어 이 쌍이 더 이상 충돌하지 않으면, 이 단정이 먼저 실패해 테스트가 조용히
    // 무의미해지는 것을 막는다.
    const projA = 'C:\\proj-229599'
    const projB = 'C:\\proj-432382'
    expect(projectKey(projA)).toBe(projectKey(projB)) // 전제: 두 경로가 실제로 해시 충돌한다
    expect(normalizeProjectPath(projA)).not.toBe(normalizeProjectPath(projB)) // 전제: 그래도 다른 프로젝트다

    const root = await tmp('astera-lh-list-collide-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()

    // store.snapshot()은 targetPath가 projectPath 하위에 실존하는지 검사하지 않는다(그 검사는
    // ipc.ts의 신뢰 경계 몫 — files.remove가 isPathWithin(projectRoot, targetPath)로 한다).
    // 그래서 실제 파일은 store가 요구하는 대로(fs.cp가 읽을 수 있게) 디스크에 두되, 그 파일이
    // 어느 "논리적 프로젝트"에 속하는지는 여기서 넘기는 projA/projB 문자열이 정한다.
    const filesDir = await tmp('astera-lh-list-collide-files-')
    const fa = path.join(filesDir, 'a.txt')
    await fs.writeFile(fa, 'a', 'utf8')
    await store.snapshot(projA, fa, false)

    const fb = path.join(filesDir, 'b.txt')
    await fs.writeFile(fb, 'b', 'utf8')
    await store.snapshot(projB, fb, false)

    // 두 스냅샷이 실제로 같은 해시 디렉터리를 공유하는지 확인 — 이게 이 테스트의 전제다
    const hashDirs = (await fs.readdir(historyDir)).filter((n) => n !== 'index.json')
    expect(hashDirs.length).toBe(1)

    // 그런데도 list()는 서로를 보지 못해야 한다
    expect(store.list(projA).length).toBe(1)
    expect(store.list(projB).length).toBe(1)
    expect(store.list(projA)[0].originalPath).toBe(fa)
    expect(store.list(projB)[0].originalPath).toBe(fb)
    expect(store.list(projA).some((e) => e.originalPath === fb)).toBe(false)
    expect(store.list(projB).some((e) => e.originalPath === fa)).toBe(false)
  })

  it('같은 경로를 대소문자·구분자만 다르게 줘도 같은 프로젝트로 취급한다', async () => {
    const root = await tmp('astera-lh-list-norm-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-list-norm-proj-')
    const f = path.join(projDir, 'x.txt')
    await fs.writeFile(f, 'x', 'utf8')
    await store.snapshot(projDir, f, false)

    const upper = projDir.toUpperCase() + '\\' // 대소문자 다르고 끝 구분자 추가
    expect(store.list(upper).length).toBe(1)
  })
})

describe('LocalHistoryStore.restore', () => {
  it('없는 id는 LOCAL_HISTORY_NOT_FOUND 코드로 던진다', async () => {
    const root = await tmp('astera-lh-restore-notfound-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-restore-notfound-proj-')
    await expect(store.restore(projDir, 'no-such-id')).rejects.toThrow(
      'LOCAL_HISTORY_NOT_FOUND: history entry not found'
    )
  })

  it('원래 경로로 복구하고, 원래 자리에 같은 이름이 있으면 uniqueName으로 회피한다', async () => {
    const root = await tmp('astera-lh-restore-ok-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-restore-ok-proj-')
    const target = path.join(projDir, 'doc.txt')
    await fs.writeFile(target, 'original content', 'utf8')
    const entry = await store.snapshot(projDir, target, false)
    await fs.rm(target) // files.remove가 스냅샷 후 실제로 지우는 것을 흉내낸다

    const dest1 = await store.restore(projDir, entry!.id)
    expect(dest1).toBe(target)
    expect(await fs.readFile(dest1, 'utf8')).toBe('original content')

    // 같은 자리에 이미 파일이 생겨 있으면(같은 이력을 두 번 복구하는 경우 포함) 새 이름으로 회피
    const dest2 = await store.restore(projDir, entry!.id)
    expect(dest2).not.toBe(target)
    expect(dest2).toContain('copy')
    expect(await fs.readFile(dest2, 'utf8')).toBe('original content')
  })

  it('validateDest 콜백이 던지면 mkdir 전에 막혀 목적지 부모 디렉터리조차 생기지 않는다 (C1, 쓰기 전에 검사)', async () => {
    // destParent가 이미 있는 경로로 테스트하면 mkdir(recursive:true)가 no-op이라 fs.cp만 막힌
    // 것을 증명할 뿐 mkdir가 검증보다 먼저 도는 회귀(C1)는 못 잡는다 — 그래서 originalPath를
    // 아직 존재하지 않는 깊은 부모 체인 아래에 두고, 콜백이 던진 뒤 그 체인 전체가 여전히 없는지
    // 확인한다.
    const root = await tmp('astera-lh-restore-validate-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-restore-validate-proj-')
    const nestedParent = path.join(projDir, 'not', 'yet', 'created')
    await fs.mkdir(nestedParent, { recursive: true }) // snapshot() 시점엔 실존해야 fs.cp가 읽을 수 있다
    const target = path.join(nestedParent, 'secret.txt')
    await fs.writeFile(target, 'secret', 'utf8')
    const entry = await store.snapshot(projDir, target, false)
    // 부모 체인 전체를 지운다 — files.remove가 대상을 지운 뒤(그리고 이 케이스에선 빈 상위
    // 폴더까지 사라진) 상태를 흉내낸다. restore()가 이 체인을 되살리기 전에 콜백이 막아야 한다.
    await fs.rm(path.join(projDir, 'not'), { recursive: true, force: true })

    await expect(
      store.restore(projDir, entry!.id, async () => {
        throw new Error('허용되지 않은 경로입니다')
      })
    ).rejects.toThrow('허용되지 않은 경로입니다')

    // 콜백이 mkdir보다 먼저 걸렸다면, 검증 전 상태(부모 체인 전체가 없음)가 그대로여야 한다.
    // C1을 고치기 전(mkdir가 validateDest보다 앞)이라면 nestedParent가 생겨 이 단정이 깨진다.
    await expect(fs.access(nestedParent)).rejects.toThrow()
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('복구해도 스냅샷은 지우지 않는다 — list()에 계속 남고 다시 복구할 수 있다', async () => {
    const root = await tmp('astera-lh-restore-keep-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-restore-keep-proj-')
    const target = path.join(projDir, 'keep.txt')
    await fs.writeFile(target, 'keep-me', 'utf8')
    const entry = await store.snapshot(projDir, target, false)
    await fs.rm(target)

    await store.restore(projDir, entry!.id)
    expect(store.list(projDir).find((e) => e.id === entry!.id)).toBeDefined()

    // 두 번째 복구도 성공해야 한다(스냅샷이 지워졌다면 여기서 ENOENT)
    const dest2 = await store.restore(projDir, entry!.id)
    expect(await fs.readFile(dest2, 'utf8')).toBe('keep-me')
  })

  it('손편집된 originalPath가 ".."로 프로젝트 밖을 가리키면 복구를 거절한다 (I-5)', async () => {
    // isSubPath(문자열 접두 비교)는 '..'를 해석하지 않아 'projDir\..\evil.txt'가 정규화된 문자열상
    // 'projDir\'로 시작한다는 이유만으로 통과했다 — 실제로는 projDir의 부모(=projDir 밖)를
    // 가리킨다. isPathWithin(path.resolve 기반)으로 바뀌었으니 이 값은 거절돼야 한다.
    const root = await tmp('astera-lh-restore-traversal-')
    const historyDir = path.join(root, 'local-history')
    const projDir = await tmp('astera-lh-restore-traversal-proj-')
    const escapedPath = path.join(projDir, '..', 'evil.txt') // projDir의 부모 — projDir 밖
    const idxPath = path.join(historyDir, 'index.json')
    await fs.mkdir(historyDir, { recursive: true })
    await fs.writeFile(
      idxPath,
      JSON.stringify({
        [normalizeProjectPath(projDir)]: [
          { id: '00000000000001-evil.txt', originalPath: escapedPath, deletedAt: 1, size: 1, isDir: false }
        ]
      }),
      'utf8'
    )
    const store = new LocalHistoryStore(historyDir)
    await store.load()

    await expect(store.restore(projDir, '00000000000001-evil.txt')).rejects.toThrow(
      'LOCAL_HISTORY_NOT_FOUND: history entry not found'
    )
    // 검증에서 막혔으니 당연히 아무것도 쓰이지 않았어야 한다
    await expect(fs.access(escapedPath)).rejects.toThrow()
  })
})

describe('LocalHistoryStore.discard', () => {
  it('커밋된 스냅샷을 index와 디스크에서 함께 지운다 (I-3, fs.rm 실패 시 files.remove가 쓴다)', async () => {
    const root = await tmp('astera-lh-discard-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-discard-proj-')
    const target = path.join(projDir, 'a.txt')
    await fs.writeFile(target, 'a', 'utf8')
    const entry = await store.snapshot(projDir, target, false)
    const projHash = (await fs.readdir(historyDir)).find((n) => n !== 'index.json')!
    const snapDir = path.join(historyDir, projHash, entry!.id)
    await expect(fs.access(snapDir)).resolves.toBeUndefined() // discard 전에는 존재

    await store.discard(projDir, entry!.id)

    expect(store.list(projDir)).toEqual([]) // index에서 빠짐
    await expect(fs.access(snapDir)).rejects.toThrow() // 디스크에서도 빠짐
    // index.json 자체에도 반영돼야 한다(재시작 후에도 유지)
    const onDisk = JSON.parse(await fs.readFile(path.join(historyDir, 'index.json'), 'utf8'))
    expect(onDisk[normalizeProjectPath(projDir)] ?? []).toEqual([])
  })

  it('없는 id는 조용히 무시한다 — index.json을 건드리지 않는다', async () => {
    const root = await tmp('astera-lh-discard-noop-')
    const historyDir = path.join(root, 'local-history')
    const store = new LocalHistoryStore(historyDir)
    await store.load()
    const projDir = await tmp('astera-lh-discard-noop-proj-')
    const target = path.join(projDir, 'a.txt')
    await fs.writeFile(target, 'a', 'utf8')
    await store.snapshot(projDir, target, false)
    const before = await fs.readFile(path.join(historyDir, 'index.json'), 'utf8')

    await store.discard(projDir, 'no-such-id') // 던지지 않아야 한다

    expect(store.list(projDir).length).toBe(1) // 기존 항목은 그대로
    const after = await fs.readFile(path.join(historyDir, 'index.json'), 'utf8')
    expect(after).toBe(before) // save()조차 부르지 않았어야 한다
  })
})
