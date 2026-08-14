import { describe, it, expect } from 'vitest'
import { runTypeIcon } from './typeIcon'
import type { FileIconSpec } from '../files/icons'
import type { RunConfigType } from './types'

/** 종류마다 그려야 하는 모양 전체. Record 라 종류가 늘면 여기서 컴파일이 깨진다 — 손으로 적은
 *  배열은 열세 번째 종류를 조용히 건너뛴다. 아래 ALL 도 이 표에서 나온다.
 *  왜 이 모양이어야 하는지(파일 트리와 같아야 한다는 것)는 아래 종류별 테스트가 따로 말한다. */
const ICONS: Record<RunConfigType, FileIconSpec> = {
  shell: { id: 'terminal', tone: 'gray' },
  npm: { id: 'code-braces', tone: 'red' },
  node: { id: 'label', tone: 'green', label: 'JS' },
  gradle: { id: 'gear', tone: 'green' },
  maven: { id: 'archive', tone: 'orange' },
  cargo: { id: 'label', tone: 'orange', label: 'RS' },
  go: { id: 'label', tone: 'cyan', label: 'GO' },
  python: { id: 'label', tone: 'green', label: 'PY' },
  pytest: { id: 'label', tone: 'green', label: 'PY', badge: 'test' },
  compose: { id: 'container', tone: 'blue' },
  dockerfile: { id: 'container', tone: 'blue' },
  dotnet: { id: 'label', tone: 'purple', label: 'C#' }
}
const ALL = Object.keys(ICONS) as RunConfigType[]

describe('runTypeIcon', () => {
  // 예전에는 falsy 가 아니라는 것만 봤다. 종류마다 객체 리터럴을 돌려주는 switch 는 falsy 일 수가
  // 없으므로 그 테스트는 () => ({ id: 'gear', tone: 'green' }) 짜리 스텁도 통과했고, 실제로 shell·
  // npm·gradle·maven 을 똑같은 톱니바퀴로 만들어도 아무 테스트가 울지 않았다
  it('종류마다 아이콘 모양을 통째로 못박는다', () => {
    for (const t of ALL) expect(runTypeIcon(t), t).toEqual(ICONS[t])
  })

  it('label 은 대문자다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label).toBe(spec.label!.toUpperCase())
    }
  })

  // 3자 라벨은 textLength 로 폭이 눌려, 14px 로 그리면 글자가 뭉개져 테두리와 겹친 것처럼 보인다.
  // 실제로 그려서 확인한 결과다 — 'NPM' 과 'MVN' 이 그랬고, 그래서 그 둘은 모양 아이콘을 쓴다
  it('label 은 두 자를 넘지 않는다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label!.length).toBeLessThanOrEqual(2)
    }
  })

  // 같은 도구가 보는 곳에 따라 달라 보이면 안 된다 — 파일 트리의 go.mod 가 청록 GO 다
  it('go 는 파일 트리의 go.mod 와 같은 모양이다', () => {
    expect(runTypeIcon('go')).toEqual({ id: 'label', tone: 'cyan', label: 'GO' })
  })

  // 파일 트리의 .py 파일과 같은 모양 — files/icons.ts 의 EXT.py 도 초록 PY 다
  it('python 은 파일 트리의 .py 파일과 같은 모양이다', () => {
    expect(runTypeIcon('python')).toEqual({ id: 'label', tone: 'green', label: 'PY' })
  })

  // pytest 는 새 모양을 만들지 않고 파일 트리의 테스트 파일 배지를 그대로 쓴다
  it('pytest 는 python 과 같은 라벨에 테스트 배지만 더한다', () => {
    expect(runTypeIcon('pytest')).toEqual({ id: 'label', tone: 'green', label: 'PY', badge: 'test' })
  })

  // 파일 트리의 docker-compose.yml/compose.yaml 과 같은 모양
  it('compose 는 파일 트리의 compose 파일과 같은 모양이다', () => {
    expect(runTypeIcon('compose')).toEqual({ id: 'container', tone: 'blue' })
  })

  // 파일 트리도 Dockerfile 과 compose 파일을 구분하지 않는다(files/icons.ts) — 여기서도 같은 모양이다
  it('dockerfile 은 compose 와 같은 모양이다 — 파일 트리도 둘을 구분하지 않는다', () => {
    expect(runTypeIcon('dockerfile')).toEqual({ id: 'container', tone: 'blue' })
  })

  // 파일 트리의 .cs 파일과 같은 모양 — files/icons.ts 의 EXT.cs 도 보라 C# 이다
  it('dotnet 은 파일 트리의 .cs 파일과 같은 모양이다', () => {
    expect(runTypeIcon('dotnet')).toEqual({ id: 'label', tone: 'purple', label: 'C#' })
  })
})
