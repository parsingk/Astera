import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SchedulerConfigStore } from './config'
import type { ScheduleConfig } from './rule'

const cfg = (command: string): ScheduleConfig => ({
  rule: { kind: 'interval', minutes: 30 },
  command
})

let tmp: string
let store: SchedulerConfigStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-schedcfg-'))
  store = new SchedulerConfigStore(path.join(tmp, 'scheduler.json'))
  await store.load()
})

describe('SchedulerConfigStore', () => {
  it('set한 설정을 get으로 돌려준다', async () => {
    await store.set('sess-1', cfg('점검'))
    expect(store.get('sess-1')).toEqual(cfg('점검'))
  })

  it('없는 키는 null', () => {
    expect(store.get('nope')).toBeNull()
  })

  it('재로드 후에도 유지된다', async () => {
    await store.set('sess-1', cfg('p'))
    const again = new SchedulerConfigStore(path.join(tmp, 'scheduler.json'))
    await again.load()
    expect(again.get('sess-1')).toEqual(cfg('p'))
  })

  it('delete하면 재로드 후에도 사라진다 (끄기 영속)', async () => {
    await store.set('sess-1', cfg('p'))
    await store.delete('sess-1')
    expect(store.get('sess-1')).toBeNull()
    const again = new SchedulerConfigStore(path.join(tmp, 'scheduler.json'))
    await again.load()
    expect(again.get('sess-1')).toBeNull()
  })

  it('없는 키 delete는 no-op', async () => {
    await expect(store.delete('nope')).resolves.toBeUndefined()
  })

  it('JSON 파싱 실패는 .bak으로 보존하고 빈 맵으로 복구한다', async () => {
    const file = path.join(tmp, 'broken.json')
    await fs.writeFile(file, '{not json', 'utf8')
    const broken = new SchedulerConfigStore(file)
    const { recovered, dropped } = await broken.load()
    expect(recovered).toBe(true)
    expect(dropped).toBe(0)
    expect(broken.get('any')).toBeNull()
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{not json')
  })

  it('최상위가 객체가 아니면(배열) .bak으로 보존하고 빈 맵으로 복구한다', async () => {
    const file = path.join(tmp, 'array.json')
    await fs.writeFile(file, JSON.stringify([1, 2, 3]), 'utf8')
    const arr = new SchedulerConfigStore(file)
    const { recovered, dropped } = await arr.load()
    expect(recovered).toBe(true)
    expect(dropped).toBe(0)
    expect(arr.get('any')).toBeNull()
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe(JSON.stringify([1, 2, 3]))
  })

  it('최상위가 객체가 아니면(null) .bak으로 보존하고 빈 맵으로 복구한다', async () => {
    const file = path.join(tmp, 'null.json')
    await fs.writeFile(file, 'null', 'utf8')
    const nullTop = new SchedulerConfigStore(file)
    const { recovered, dropped } = await nullTop.load()
    expect(recovered).toBe(true)
    expect(dropped).toBe(0)
  })

  it('스키마가 틀린 항목이 섞여 있으면 그 항목만 버리고 나머지는 유지한다', async () => {
    const file = path.join(tmp, 'badschema.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        good: cfg('멀쩡한 세션'),
        bad: { rule: { kind: 'interval', minutes: 0 }, command: 'x' } // minutes=0은 무효(최소 1)
      }),
      'utf8'
    )
    const original = await fs.readFile(file, 'utf8')
    const store = new SchedulerConfigStore(file)
    const { recovered, dropped } = await store.load()
    // ① 유효 항목은 살아남는다
    expect(store.get('good')).toEqual(cfg('멀쩡한 세션'))
    expect(store.get('bad')).toBeNull()
    // ② dropped가 맞다 — 전체 복구가 아니므로 recovered는 false
    expect(recovered).toBe(false)
    expect(dropped).toBe(1)
    // ③ .bak에 원본이 남는다
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe(original)
    // ④ 재로드 시 무효 항목이 이미 파일에서 정리돼 dropped가 0이다 (즉시 재저장 확인)
    const reload = new SchedulerConfigStore(file)
    const second = await reload.load()
    expect(second.dropped).toBe(0)
    expect(second.recovered).toBe(false)
    expect(reload.get('good')).toEqual(cfg('멀쩡한 세션'))
  })

  it('전 항목이 무효면 빈 맵 + dropped=N, recovered는 false (특별 분기 없음)', async () => {
    const file = path.join(tmp, 'allbad.json')
    await fs.writeFile(
      file,
      JSON.stringify({ a: { rule: { kind: 'interval', minutes: 0 }, command: 'x' } }),
      'utf8'
    )
    const store = new SchedulerConfigStore(file)
    const { recovered, dropped } = await store.load()
    expect(recovered).toBe(false)
    expect(dropped).toBe(1)
    expect(store.get('a')).toBeNull()
  })

  it('dropped 정리 재저장(save)이 실패해도 load()는 reject하지 않는다', async () => {
    const file = path.join(tmp, 'saveFail.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        good: cfg('멀쩡한 세션'),
        bad: { rule: { kind: 'interval', minutes: 0 }, command: 'x' } // minutes=0은 무효 → dropped 유발
      }),
      'utf8'
    )
    const store = new SchedulerConfigStore(file)
    // Windows의 rename 실패(잠금·읽기전용·디스크 부족 등)를 흉내낸다 — load() 내부의 무보호
    // save()가 이걸 삼키지 않으면 createCore가 reject해 앱 창이 안 뜬다 (I-1)
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    // 반환형에 pruned가 추가됐다 — toEqual은 정확한 키 집합을 요구하므로 갱신 (이
    // 시나리오엔 만료 대상이 없어 pruned=0)
    await expect(store.load()).resolves.toEqual({ recovered: false, dropped: 1, pruned: 0 })
    expect(store.get('good')).toEqual(cfg('멀쩡한 세션')) // 메모리 상 정리 결과는 재저장 실패와 무관하게 유효
    renameSpy.mockRestore()
  })

  it('파일이 없으면 빈 맵으로 시작한다', async () => {
    const fresh = new SchedulerConfigStore(path.join(tmp, 'absent.json'))
    const { recovered, dropped } = await fresh.load()
    expect(recovered).toBe(false)
    expect(dropped).toBe(0)
    expect(fresh.get('any')).toBeNull()
  })

  // config.ts의 ENTRY_TTL_MS(30일)와 동일한 값 — 상수 자체는 export하지 않으므로 테스트에서
  // 같은 크기로 재계산해 시간 조작에 쓴다
  const TTL_MS = 30 * 24 * 60 * 60_000

  it('새 형태({config, updatedAt})로 저장되고, 재로드 후에도 그 형태를 유지한다', async () => {
    const file = path.join(tmp, 'roundtrip.json')
    const fixedNow = 1_700_000_000_000
    const s = new SchedulerConfigStore(file, () => fixedNow)
    await s.load()
    await s.set('sess-1', cfg('p'))
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw['sess-1']).toEqual({ config: cfg('p'), updatedAt: fixedNow })
    const again = new SchedulerConfigStore(file, () => fixedNow)
    await again.load()
    expect(again.get('sess-1')).toEqual(cfg('p'))
  })

  it('set()은 호출 시점의 현재 시각으로 updatedAt을 스탬프한다', async () => {
    const file = path.join(tmp, 'stamp.json')
    let t = 1_000_000
    const s = new SchedulerConfigStore(file, () => t)
    await s.load()
    await s.set('sess-1', cfg('a'))
    t = 2_000_000
    await s.set('sess-1', cfg('b'))
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw['sess-1'].updatedAt).toBe(2_000_000)
  })

  it('updatedAt이 TTL을 넘은 항목은 load() 시 정리되고 pruned에 반영된다', async () => {
    const file = path.join(tmp, 'ttl.json')
    const base = 1_700_000_000_000
    const s = new SchedulerConfigStore(file, () => base)
    await s.load()
    await s.set('old', cfg('만료 대상'))
    const reload = new SchedulerConfigStore(file, () => base + TTL_MS + 1)
    const { recovered, dropped, pruned } = await reload.load()
    expect(recovered).toBe(false)
    expect(dropped).toBe(0)
    expect(pruned).toBe(1)
    expect(reload.get('old')).toBeNull()
  })

  it('updatedAt이 TTL 이내인 항목은 정리되지 않고 살아남는다', async () => {
    const file = path.join(tmp, 'ttl-ok.json')
    const base = 1_700_000_000_000
    const s = new SchedulerConfigStore(file, () => base)
    await s.load()
    await s.set('fresh', cfg('생존'))
    const reload = new SchedulerConfigStore(file, () => base + TTL_MS - 1)
    const { dropped, pruned } = await reload.load()
    expect(dropped).toBe(0)
    expect(pruned).toBe(0)
    expect(reload.get('fresh')).toEqual(cfg('생존'))
  })

  it('레거시 형태(래퍼 없음)는 승격되고, 재로드 시 새 형태로 굳어 있다 — 승격만으론 .bak을 남기지 않는다', async () => {
    const file = path.join(tmp, 'legacy.json')
    await fs.writeFile(file, JSON.stringify({ old: cfg('레거시') }), 'utf8')
    const s = new SchedulerConfigStore(file)
    const { recovered, dropped, pruned } = await s.load()
    expect(recovered).toBe(false)
    expect(dropped).toBe(0)
    expect(pruned).toBe(0)
    expect(s.get('old')).toEqual(cfg('레거시'))
    // 마이그레이션은 파괴적이지 않다 — dropped/pruned가 없으므로 .bak을 남기지 않는다
    await expect(fs.access(file + '.bak')).rejects.toThrow()
    // 재기록은 됐다(재실행마다 재마이그레이션을 피하려고) — 파일 형태가 새 형태로 굳어 있다
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.old).toHaveProperty('config')
    expect(raw.old).toHaveProperty('updatedAt')
    const reload = new SchedulerConfigStore(file)
    const second = await reload.load()
    expect(second.dropped).toBe(0)
    expect(second.pruned).toBe(0)
    expect(reload.get('old')).toEqual(cfg('레거시'))
  })

  it('만료 정리 시 .bak에 정리 전 원본이 남는다', async () => {
    const file = path.join(tmp, 'ttl-bak.json')
    const base = 1_700_000_000_000
    const s = new SchedulerConfigStore(file, () => base)
    await s.load()
    await s.set('old', cfg('만료 대상'))
    const original = await fs.readFile(file, 'utf8')
    const reload = new SchedulerConfigStore(file, () => base + TTL_MS + 1)
    const { pruned } = await reload.load()
    expect(pruned).toBe(1)
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe(original)
  })

  // resume 복원 시 ipc.ts가 같은 키로 set()을 재호출해 재스탬프한다 —
  // 이 테스트는 그 재스탬프가 실제로 리스를 연장한다는 불변식을 못박는다. 재스탬프가 없다면
  // 매일 resume해 계속 쓰는 스케쥴도 최초 저장 시각(T0) 기준 30일 뒤 조용히 pruned된다.
  it('같은 키로 set()을 다시 부르면 updatedAt이 갱신돼 만료를 넘긴다', async () => {
    const file = path.join(tmp, 'restamp.json')
    const base = 1_700_000_000_000
    let t = base
    const s = new SchedulerConfigStore(file, () => t)
    await s.load()
    await s.set('sess-1', cfg('a')) // T0 최초 저장
    t = base + TTL_MS - 1_000 // T0 기준 TTL 임박 — resume으로 재스탬프
    await s.set('sess-1', cfg('a'))
    t = base + TTL_MS + 1_000 // T0 기준으로는 이미 만료됐을 시각
    const reload = new SchedulerConfigStore(file, () => t)
    const { pruned } = await reload.load()
    expect(pruned).toBe(0) // 재스탬프 덕분에 T0 기준 TTL을 넘겨도 살아남는다
    expect(reload.get('sess-1')).toEqual(cfg('a'))
  })

  // 다중 키 보존 불변식(리뷰가 명시적으로 경고한 함정) — 한 키를 set()해도 다른 키의
  // updatedAt이 덩달아 갱신되면 안 된다(예: save()가 맵 전체를 훑으며 스탬프를 다시 찍는 버그).
  it('키 B를 set해도 키 A의 updatedAt은 그대로 보존된다 (다중 키 보존 불변식)', async () => {
    const file = path.join(tmp, 'multikey.json')
    const oldUpdatedAt = 1_700_000_000_000
    await fs.writeFile(file, JSON.stringify({ A: { config: cfg('a'), updatedAt: oldUpdatedAt } }), 'utf8')
    const s = new SchedulerConfigStore(file, () => oldUpdatedAt + 1_000)
    await s.load()
    await s.set('B', cfg('b'))
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.A.updatedAt).toBe(oldUpdatedAt)
  })
})
