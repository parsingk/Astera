import { describe, it, expect } from 'vitest'
import { layersOf } from './graph'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Run, Task } from './types'
import { absPath } from '../testPaths'

const T = (n: number): string => `2026-08-18T00:0${n}:00.000Z`
const run = (id: string): Run => ({
  id, objective: `objective ${id}`, cwd: absPath('p'), createdAt: T(0)
})
// timeline.test.ts 의 task() 와 같은 모양이되, deps 를 받는 인자가 하나 더 있다 — 고정된
// deps: [] 로는 의존 그래프를 다루는 이 테스트들을 쓸 수 없다.
const task = (id: string, runId: string, deps: string[] = [], createdAt = T(1)): Task => ({
  id, runId, title: `task ${id}`, spec: '', deps, status: 'pending',
  consecutiveFailures: 0, createdAt, updatedAt: createdAt
})
const state = (p: Partial<OrchState>): OrchState => ({ ...emptyState(), ...p })

describe('layersOf', () => {
  it('deps 가 없는 Task 는 0층이다', () => {
    const s = state({ runs: [run('r1')], tasks: [task('a', 'r1')] })
    expect(layersOf(s, 'r1')).toEqual({ layers: [['a']], cyclic: [] })
  })

  it('사슬 A→B→C 는 세 층이다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [
        task('a', 'r1', [], T(1)),
        task('b', 'r1', ['a'], T(2)),
        task('c', 'r1', ['b'], T(3))
      ]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['a'], ['b'], ['c']])
  })

  // 갈래가 같은 층에 서는 것이 이 함수의 요점이다 — 병렬이 정상이기 때문이다
  it('갈래 A→B, A→C 에서 B 와 C 는 같은 층이다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [
        task('a', 'r1', [], T(1)),
        task('b', 'r1', ['a'], T(2)),
        task('c', 'r1', ['a'], T(3))
      ]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['a'], ['b', 'c']])
  })

  it('합류 B→D, C→D 에서 D 는 B·C 보다 깊다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [
        task('b', 'r1', [], T(1)),
        task('c', 'r1', [], T(2)),
        task('d', 'r1', ['b', 'c'], T(3))
      ]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['b', 'c'], ['d']])
  })

  // 가장 깊은 의존을 따라야 D 가 B 위에 그려지지 않는다
  it('층을 건너뛰는 의존(A→D 이면서 A→B→D)에서 D 는 가장 깊은 의존을 따른다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [
        task('a', 'r1', [], T(1)),
        task('b', 'r1', ['a'], T(2)),
        task('d', 'r1', ['a', 'b'], T(3))
      ]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['a'], ['b'], ['d']])
  })

  it('같은 층 안에서는 createdAt 순서가 보존된다', () => {
    const s = state({
      runs: [run('r1')],
      // id 의 알파벳 순서와 배열에 놓인 순서 둘 다 createdAt 순서와 반대로 둔다 — 함수가 그중
      //하나에 기대고 있었다면 이 테스트가 잡아낸다
      tasks: [task('a', 'r1', [], T(2)), task('z', 'r1', [], T(1))]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['z', 'a']])
  })

  it('다른 Run 의 Task 는 섞이지 않는다', () => {
    const s = state({
      runs: [run('r1'), run('r2')],
      tasks: [task('a', 'r1'), task('x', 'r2')]
    })
    expect(layersOf(s, 'r1').layers).toEqual([['a']])
  })

  // 다른 Run 의 Task 를 가리키는 deps 는 이 Run 의 순서에 영향을 줄 수 없다
  it('이 Run 밖을 가리키는 deps 는 무시한다', () => {
    const s = state({
      runs: [run('r1'), run('r2')],
      tasks: [task('x', 'r2'), task('a', 'r1', ['x'])]
    })
    expect(layersOf(s, 'r1')).toEqual({ layers: [['a']], cyclic: [] })
  })

  it('순환 A→B→A 는 layers 에 없고 cyclic 으로 빠진다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [task('a', 'r1', ['b'], T(1)), task('b', 'r1', ['a'], T(2))]
    })
    expect(layersOf(s, 'r1')).toEqual({ layers: [], cyclic: ['a', 'b'] })
  })

  // 순환 자체가 아니라 그 뒤에 매달린 Task 도 순서를 정할 수 없다
  it('순환에 의존하는 Task 도 cyclic 이다', () => {
    const s = state({
      runs: [run('r1')],
      tasks: [
        task('a', 'r1', ['b'], T(1)),
        task('b', 'r1', ['a'], T(2)),
        task('c', 'r1', ['a'], T(3))
      ]
    })
    expect(layersOf(s, 'r1')).toEqual({ layers: [], cyclic: ['a', 'b', 'c'] })
  })

  it('Task 가 없는 Run 은 빈 층과 빈 cyclic 이다', () => {
    const s = state({ runs: [run('r1')] })
    expect(layersOf(s, 'r1')).toEqual({ layers: [], cyclic: [] })
  })
})
