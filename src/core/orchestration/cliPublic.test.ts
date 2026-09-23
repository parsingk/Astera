import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicFor } from './cliPublic'
import type { Task } from './types'

describe('publicFor', () => {
  it('허용된 칸만 남긴다', () => {
    const job = { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', secret: 'x' }
    expect(publicFor('jobs-get', job)).toEqual({
      id: 'job_1',
      objective: 'o',
      cwd: 'D:/p',
      createdAt: 'T'
    })
  })

  // 없는 것을 undefined 로 찍으면 JSON 에서 사라져 결과는 같지만, 있는데 비어 있는 것과
  // 아예 없는 것이 한 모양이 된다
  it('없는 칸을 만들지 않는다', () => {
    expect(publicFor('projects-get', { id: 'proj_1', path: 'D:/p' })).toEqual({
      id: 'proj_1',
      path: 'D:/p'
    })
  })

  it('목록은 하나씩 가린다', () => {
    const out = publicFor('runs-list', [
      { id: 'run_1', jobId: 'job_1', ordinal: 1, internal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2, internal: 2 }
    ])
    expect(out).toEqual([
      { id: 'run_1', jobId: 'job_1', ordinal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2 }
    ])
  })

  // **한 겹 안이라고 새면 가림막이 아니다.** jobs get 은 회차를 `run` 에 접어 싣는다(설계 §5)
  it('jobs get 이 접어 실은 회차도 가린다', () => {
    const out = publicFor('jobs-get', {
      id: 'job_1',
      objective: 'o',
      run: { id: 'run_1', jobId: 'job_1', ordinal: 1, internalNote: 'x' }
    }) as { run: Record<string, unknown> }
    expect(out.run).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
  })

  // 앱이 수렴을 굴리려고 적어 두는 장부다 — 내보내면 정책을 바꿀 때마다 남의 스크립트가 깨진다
  it('Task 의 수렴 장부는 내보내지 않는다', () => {
    const task: Partial<Task> = {
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0,
      checkHistory: { c1: ['passed'] },
      policySnapshot: { key: 'k', capturedAt: 'T' },
      policyChanged: true,
      convergenceStartedAt: 'T',
      convergenceOff: true,
      suspiciousFiles: ['a.ts'],
      reviewRequested: true
    }
    const out = publicFor('tasks-list', [task]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0
    })
  })

  // 가이드가 코디네이터에게 읽으라고 말하는 칸들 — 가리면 오케스트레이션이 멈춘다
  it('가이드가 읽으라는 Task 칸은 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', parentId: 'p1', checks: [{ id: 'c' }], consecutiveFailures: 2, deps: ['t0'] }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 't1',
      parentId: 'p1',
      checks: [{ id: 'c' }],
      consecutiveFailures: 2,
      deps: ['t0']
    })
  })

  // --brief 가 잘린 자리를 알리려고 만드는 칸이다. Task 에는 없으므로 따로 허용해야 한다
  it('tasks list --brief 가 덧붙이는 칸을 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', spec: '짧게', spec_truncated: true }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({ id: 't1', spec: '짧게', spec_truncated: true })
  })

  // phase C 의 셋. 새 목록을 만들지 않는다 — 개체마다 한 목록이다(설계 §11).
  it('jobs create 는 계획으로, tasks add 는 Task 로 가린다', () => {
    expect(
      publicFor('jobs-create', { id: 'job_1', objective: 'o', pendingStart: true, outcome: 'running', secret: 1 })
    ).toEqual({ id: 'job_1', objective: 'o', pendingStart: true, outcome: 'running' })
    expect(publicFor('tasks-add', { id: 't1', jobId: 'job_1', reviewRequested: true, policyChanged: true }))
      .toEqual({ id: 't1', jobId: 'job_1' })
  })

  it('accounts list 는 id·label·provider 셋만 낸다', () => {
    expect(
      publicFor('accounts-list', [{ id: 'a1', label: '일', provider: 'claude', configDir: 'C:/secret' }])
    ).toEqual([{ id: 'a1', label: '일', provider: 'claude' }])
  })

  // skills 의 답은 계정 목록 안에 스킬 목록이 접힌 모양이다. 두 겹 모두 같은 규칙으로 가린다 —
  // 계정의 configDir 도, 스킬 파일의 경로도 나가지 않는다.
  it('skills list 와 install 은 계정과 그 안의 스킬을 둘 다 가린다', () => {
    const account = {
      id: 'a1',
      label: '일',
      provider: 'claude',
      configDir: 'C:/secret',
      skills: [{ name: 'astera-task', enabled: true, installed: 'current', path: 'C:/secret/skills' }]
    }
    expect(publicFor('skills-list', { accounts: [account], extra: 1 })).toEqual({
      accounts: [
        { id: 'a1', label: '일', provider: 'claude', skills: [{ name: 'astera-task', enabled: true, installed: 'current' }] }
      ]
    })
    expect(
      publicFor('skills-install', {
        accounts: [{ ...account, skills: [{ name: 'astera-task', result: 'written', path: 'C:/secret' }] }],
        notEnabled: [{ name: 'astera-browser', setting: 'Settings → Agents → Agent browser', stubPath: 'x' }],
        note: 'n'
      })
    ).toEqual({
      accounts: [{ id: 'a1', label: '일', provider: 'claude', skills: [{ name: 'astera-task', result: 'written' }] }],
      notEnabled: [{ name: 'astera-browser', setting: 'Settings → Agents → Agent browser' }],
      note: 'n'
    })
  })

  // 세션의 note 는 앱이 자기에게 남긴 말이라 무엇이든 들 수 있다 — 여섯 칸만 나간다.
  it('sessions 셋은 제 칸만 낸다', () => {
    const row = { id: 's1', kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, ptyId: 'p1' }
    expect(publicFor('sessions-list', [row])).toEqual([
      { id: 's1', kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/p', alive: true }
    ])
    expect(
      publicFor('sessions-read', { id: 's1', alive: true, cols: 80, rows: 24, screen: ['hi'], scrollback: [], raw: 'x' })
    ).toEqual({ id: 's1', alive: true, cols: 80, rows: 24, screen: ['hi'], scrollback: [] })
    expect(publicFor('sessions-send', { id: 's1', sent: true, enter: false, extra: 1 })).toEqual({
      id: 's1',
      sent: true,
      enter: false
    })
  })

  // **코디네이터 전용 명령은 이 계약의 약속 밖이다.** 가리려 들면 가이드가 시키는 것을 못 읽는다
  it('표에 없는 명령은 그대로 지나간다', () => {
    const body = { dispatchId: 'd1', anything: { nested: true } }
    expect(publicFor('dispatch-show', body)).toBe(body)
  })

  it('객체가 아닌 것은 그대로 둔다', () => {
    expect(publicFor('jobs-list', [])).toEqual([])
    expect(publicFor('questions-get', null)).toBe(null)
  })
})

// **core 는 cli 도 main 도 가져오지 않는다.** 타입만 가져와도 그 줄이 값 가져오기로 바뀌는 날 core 가
// 앱 쪽 모듈을 통째로 끌고 온다 — skills 의 답 타입은 그래서 core 에 있다(./skills).
describe('cliPublic 의 가져오기', () => {
  it('src/cli 와 src/main 에서 아무것도 가져오지 않는다', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cliPublic.ts'), 'utf8')
    expect(src).not.toMatch(/from '\.\.\/\.\.\/(cli|main)\//)
  })
})
