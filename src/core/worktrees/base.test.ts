import { describe, it, expect } from 'vitest'
import type { BranchRef } from '../types'
import { orderBranchesForPicker, reconcileBaseRef, resolveInitialBase, workerBaseFailure } from './base'

const b = (name: string, over: Partial<BranchRef> = {}): BranchRef => ({
  name,
  remote: false,
  current: false,
  updatedAt: '2026-08-11T00:00:00Z',
  ...over
})

describe('resolveInitialBase', () => {
  it('감지된 기준이 있으면 그것을 쓴다', () => {
    expect(resolveInitialBase({ branches: [b('main'), b('develop')], detected: 'origin/main' })).toBe(
      'origin/main'
    )
  })

  it('감지에 실패했지만 브랜치가 있으면 가장 최신 브랜치를 쓴다', () => {
    // main·master도 origin도 없는 repo — 자동 감지는 null이지만 develop으로 worktree를 딸 수 있다.
    // 여기서 빈 값을 돌려주면 셀렉트가 비고 생성이 NO_BASE로 죽는다
    expect(resolveInitialBase({ branches: [b('develop'), b('spike')], detected: null })).toBe('develop')
  })

  it('브랜치도 감지 결과도 없으면 null — worktree 를 만들 수 없다', () => {
    // 커밋이 하나도 없는 repo(갓 git init)가 이 상태다
    expect(resolveInitialBase({ branches: [], detected: null })).toBeNull()
  })

  it('브랜치가 없어도 감지 결과가 있으면 그것을 쓴다', () => {
    // 목록 조회만 실패한 경우 — 감지가 답을 주면 만들 수 있다
    expect(resolveInitialBase({ branches: [], detected: 'main' })).toBe('main')
  })

  it('목록의 순서를 신뢰한다 — listBranches가 최신 커밋 순으로 정렬해서 준다', () => {
    const list = [b('origin/newest', { remote: true }), b('older')]
    expect(resolveInitialBase({ branches: list, detected: null })).toBe('origin/newest')
  })
})

describe('orderBranchesForPicker', () => {
  const at = (name: string, over: Partial<BranchRef>): BranchRef => b(name, over)

  it('현재 브랜치 → 원격 → 로컬 순서로 묶는다', () => {
    // listBranches는 전체를 날짜순으로 주므로 원격·로컬이 뒤섞여 온다. 그대로 그리면 그룹 제목이
    // 원격/로컬/원격/로컬로 반복된다 — 이 함수가 그걸 두 덩어리로 만든다
    const input = [
      at('origin/newest', { remote: true, updatedAt: '2026-08-11T00:00:00Z' }),
      at('develop', { current: true, updatedAt: '2026-08-10T00:00:00Z' }),
      at('main', { updatedAt: '2026-08-09T00:00:00Z' }),
      at('origin/older', { remote: true, updatedAt: '2026-08-08T00:00:00Z' })
    ]
    expect(orderBranchesForPicker(input).map((x) => x.name)).toEqual([
      'develop',
      'origin/newest',
      'origin/older',
      'main'
    ])
  })

  it('그룹 안에서는 받은 순서를 그대로 유지한다 — listBranches가 이미 최신 커밋 순이다', () => {
    const input = [
      at('origin/a', { remote: true, updatedAt: '2026-08-11T00:00:00Z' }),
      at('origin/b', { remote: true, updatedAt: '2026-08-10T00:00:00Z' }),
      at('origin/c', { remote: true, updatedAt: '2026-08-09T00:00:00Z' })
    ]
    expect(orderBranchesForPicker(input).map((x) => x.name)).toEqual(['origin/a', 'origin/b', 'origin/c'])
  })

  it('현재 브랜치는 로컬 그룹에서 빠진다 — 두 번 나오면 안 된다', () => {
    const input = [at('develop', { current: true }), at('main', {})]
    const out = orderBranchesForPicker(input)
    expect(out.filter((x) => x.name === 'develop')).toHaveLength(1)
    expect(out.map((x) => x.name)).toEqual(['develop', 'main'])
  })

  it('현재 브랜치가 없어도(detached HEAD) 동작한다', () => {
    const input = [at('origin/main', { remote: true }), at('main', {})]
    expect(orderBranchesForPicker(input).map((x) => x.name)).toEqual(['origin/main', 'main'])
  })

  it('원격만 있거나 로컬만 있어도 동작한다', () => {
    expect(orderBranchesForPicker([at('origin/x', { remote: true })]).map((x) => x.name)).toEqual(['origin/x'])
    expect(orderBranchesForPicker([at('x', {})]).map((x) => x.name)).toEqual(['x'])
  })

  it('빈 목록은 빈 목록', () => {
    expect(orderBranchesForPicker([])).toEqual([])
  })
})

describe('reconcileBaseRef', () => {
  it('고른 값이 목록에 그대로 있으면 유지한다', () => {
    // 체크박스를 껐다 켜도 사용자가 고른 값이 초기화되면 안 된다
    const branches = [b('develop'), b('main')]
    expect(reconcileBaseRef({ branches, detected: 'main', current: 'develop' })).toBe('develop')
  })

  it('고른 값이 새 목록에 없으면 감지된 기준으로 되돌린다', () => {
    // 모달을 열어둔 채 프로젝트 폴더를 바꾼 경우 — 앞 repo 의 브랜치명이 남아 있으면
    // Select 가 일치 항목을 못 찾아 '선택 안됨'이 뜬다
    const branches = [b('trunk'), b('release')]
    expect(reconcileBaseRef({ branches, detected: 'trunk', current: 'develop' })).toBe('trunk')
  })

  it('고른 값이 없으면 감지된 기준을 쓴다', () => {
    expect(reconcileBaseRef({ branches: [b('main')], detected: 'main', current: '' })).toBe('main')
  })

  it('고른 값도 없고 감지도 실패하면 가장 최신 브랜치', () => {
    expect(reconcileBaseRef({ branches: [b('spike'), b('old')], detected: null, current: '' })).toBe('spike')
  })

  it('브랜치가 하나도 없으면 null — 만들 수 없는 상태', () => {
    expect(reconcileBaseRef({ branches: [], detected: null, current: 'develop' })).toBeNull()
  })

  it('브랜치 목록이 비었지만 감지 결과가 있으면 그것을 쓴다', () => {
    expect(reconcileBaseRef({ branches: [], detected: 'main', current: 'develop' })).toBe('main')
  })

  it('이름이 같아도 원격/로컬 표기가 다르면 다른 값으로 본다', () => {
    // 'develop' 을 골랐는데 새 repo 에는 'origin/develop' 만 있는 경우
    const branches = [b('origin/develop', { remote: true })]
    expect(reconcileBaseRef({ branches, detected: 'origin/develop', current: 'develop' })).toBe(
      'origin/develop'
    )
  })
})

describe('workerBaseFailure', () => {
  // 이 함수가 있는 이유의 시험대. 폴더가 사라진 것을 "분리된 HEAD" 라고 말하던 것이 그 결함이다
  it('저장소에 닿을 수 없으면 그 사실을 말한다 — 분리된 HEAD 라고 하지 않는다', () => {
    const msg = workerBaseFailure({
      repoPath: 'C:/gone',
      repoReachable: false,
      onBranch: false,
      stderr: "fatal: cannot change to 'C:/gone': No such file or directory"
    })
    expect(msg).toContain('NO_REPO')
    expect(msg).toContain('C:/gone')
    expect(msg).toContain('No such file or directory')
    expect(msg).not.toContain('detached')
  })

  it('저장소에 닿는데 브랜치가 아니면 분리된 HEAD 다', () => {
    const msg = workerBaseFailure({ repoPath: 'C:/repo', repoReachable: true, onBranch: false })
    expect(msg).toContain('NO_BASE')
    expect(msg).toContain('detached')
  })

  it('브랜치 위에 있으면 실패가 없다', () => {
    expect(workerBaseFailure({ repoPath: 'C:/repo', repoReachable: true, onBranch: true })).toBeNull()
  })
})
