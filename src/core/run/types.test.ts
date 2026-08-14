import { describe, it, expect } from 'vitest'
import { optionalFieldsFor, availableOptionalFields } from './types'
import type { RunConfigType } from './types'

/** 종류마다 내놓아야 하는 선택 항목 전체. Record 라 종류가 늘면 여기서 컴파일이 깨진다.
 *  아래 개별 테스트들이 규칙을 설명한다면 이 표는 목록 자체를 못박는다 — 예전에는 여덟 개 키
 *  (packageManager·nodePath·release·features·packagePath·dockerfilePath·buildArgs·runArgs) 가
 *  한 번도 확인되지 않아, 다섯 종류의 반환을 [...common] 으로 바꿔도 테스트가 모두 초록이었다. */
const OPTIONAL: Record<RunConfigType, string[]> = {
  shell: ['cwd', 'env'],
  npm: ['packageManager', 'args', 'cwd', 'env'],
  node: ['nodePath', 'args', 'cwd', 'env'],
  gradle: ['javaHome', 'args', 'cwd', 'env'],
  maven: ['javaHome', 'args', 'cwd', 'env'],
  cargo: ['release', 'features', 'args', 'cwd', 'env'],
  go: ['packagePath', 'args', 'cwd', 'env'],
  python: ['interpreter', 'args', 'cwd', 'env'],
  pytest: ['target', 'interpreter', 'args', 'cwd', 'env'],
  compose: ['composeFile', 'services', 'action', 'args', 'cwd', 'env'],
  dockerfile: ['dockerfilePath', 'buildArgs', 'runArgs', 'cwd', 'env'],
  dotnet: ['subcommand', 'configuration', 'args', 'cwd', 'env']
}

describe('optionalFieldsFor', () => {
  it('종류마다 선택 항목 목록 전체를 순서까지 못박는다', () => {
    for (const [type, fields] of Object.entries(OPTIONAL)) {
      expect(optionalFieldsFor(type as RunConfigType, { springBoot: false }), type).toEqual(fields)
    }
  })

  // springBoot 는 JVM 두 종류에만 한 항목을 끼워 넣는다 — 나머지 열 종류는 이 값에 흔들리지 않는다
  it('springBoot 는 gradle·maven 에만 springProfiles 를 끼워 넣는다', () => {
    expect(optionalFieldsFor('gradle', { springBoot: true })).toEqual([
      'javaHome', 'springProfiles', 'args', 'cwd', 'env'
    ])
    expect(optionalFieldsFor('maven', { springBoot: true })).toEqual([
      'javaHome', 'springProfiles', 'args', 'cwd', 'env'
    ])
    for (const type of Object.keys(OPTIONAL) as RunConfigType[]) {
      if (type === 'gradle' || type === 'maven') continue
      expect(optionalFieldsFor(type, { springBoot: true }), type).toEqual(OPTIONAL[type])
    }
  })

  it('모든 종류에 cwd 와 env 가 있다', () => {
    for (const t of Object.keys(OPTIONAL) as RunConfigType[]) {
      expect(optionalFieldsFor(t, { springBoot: false })).toContain('cwd')
      expect(optionalFieldsFor(t, { springBoot: false })).toContain('env')
    }
  })

  // 지금 결함의 회귀 방지: JDK 는 JVM 종류에만 있어야 한다
  it('javaHome 은 JVM 종류에만 있다', () => {
    expect(optionalFieldsFor('gradle', { springBoot: false })).toContain('javaHome')
    expect(optionalFieldsFor('maven', { springBoot: false })).toContain('javaHome')
    expect(optionalFieldsFor('npm', { springBoot: false })).not.toContain('javaHome')
    expect(optionalFieldsFor('node', { springBoot: false })).not.toContain('javaHome')
    expect(optionalFieldsFor('cargo', { springBoot: false })).not.toContain('javaHome')
  })

  it('springProfiles 는 Boot 프로젝트의 JVM 종류에만 있다', () => {
    expect(optionalFieldsFor('gradle', { springBoot: true })).toContain('springProfiles')
    expect(optionalFieldsFor('gradle', { springBoot: false })).not.toContain('springProfiles')
    expect(optionalFieldsFor('npm', { springBoot: true })).not.toContain('springProfiles')
  })

  it('shell 은 인자 필드를 갖지 않는다 — 명령에 직접 적는다', () => {
    expect(optionalFieldsFor('shell', { springBoot: false })).not.toContain('args')
    expect(optionalFieldsFor('npm', { springBoot: false })).toContain('args')
  })

  // pytest 만 target 을 갖는다 — python 은 실행할 파일이 required 필드라 target 이 필요 없다
  it('target 은 pytest 에만 있다', () => {
    expect(optionalFieldsFor('pytest', { springBoot: false })).toContain('target')
    expect(optionalFieldsFor('python', { springBoot: false })).not.toContain('target')
  })

  it('python 과 pytest 는 interpreter 를 공유한다', () => {
    expect(optionalFieldsFor('python', { springBoot: false })).toContain('interpreter')
    expect(optionalFieldsFor('pytest', { springBoot: false })).toContain('interpreter')
  })

  // dotnet 의 subcommand 는 cargo·go 와 달리 선택 항목이다 — 비면 run 이라, 필수로 둘 이유가 없다
  it('subcommand 는 dotnet 에서만 선택 항목이다', () => {
    expect(optionalFieldsFor('dotnet', { springBoot: false })).toContain('subcommand')
    expect(optionalFieldsFor('dotnet', { springBoot: false })).toContain('configuration')
    expect(optionalFieldsFor('cargo', { springBoot: false })).not.toContain('subcommand')
    expect(optionalFieldsFor('go', { springBoot: false })).not.toContain('subcommand')
  })

  // compose 는 필수 필드가 없다 — composeFile·services 모두 선택 항목으로 추가한다
  it('compose 는 composeFile 과 services 를 선택 항목으로 갖는다', () => {
    expect(optionalFieldsFor('compose', { springBoot: false })).toContain('composeFile')
    expect(optionalFieldsFor('compose', { springBoot: false })).toContain('services')
    expect(optionalFieldsFor('compose', { springBoot: false })).toContain('action')
  })
})

// optionalFieldsFor 의 유일한 소비자. RunConfigForm 은 vitest 가 environment: 'node' 라 그릴 수
// 없으므로, 폼이 내리던 이 판단만 core 로 옮겨 여기서 직접 돌린다 — 이 종류 모델이 애초에 고치려던
// 결함(Node 프로젝트에 JDK 칸이 그려지던 것)이 실제로 걸리는 층이 여기다
describe('availableOptionalFields', () => {
  const base = { id: 'x', name: 'x' } as const

  it('종류에 없는 항목은 메뉴에 오르지 않는다 — Node 구성에 JDK·Spring 프로파일은 없다', () => {
    const menu = availableOptionalFields(
      { ...base, type: 'node', file: 'server/app.js' },
      { springBoot: true },
      new Set()
    )
    expect(menu).not.toContain('javaHome')
    expect(menu).not.toContain('springProfiles')
    expect(menu).toEqual(['nodePath', 'args', 'cwd', 'env'])
  })

  it('이미 값이 있는 항목은 빠진다 — 값 자체가 "화면에 있다" 는 기록이다', () => {
    expect(
      availableOptionalFields(
        { ...base, type: 'node', file: 'server/app.js', nodePath: 'C:\\node\\node.exe' },
        { springBoot: false },
        new Set()
      )
    ).toEqual(['args', 'cwd', 'env'])
  })

  it('이번 편집에서 추가한 항목도 빠진다 — 아직 값이 없어도', () => {
    expect(
      availableOptionalFields(
        { ...base, type: 'go', subcommand: 'run' },
        { springBoot: false },
        new Set(['packagePath', 'env'])
      )
    ).toEqual(['args', 'cwd'])
  })

  // 빈 문자열도, false 도 undefined 가 아니므로 값으로 친다 — 지우거나 체크를 푼 칸이 메뉴로
  // 되돌아가면 그 자리에서 사라져 버린다
  it('빈 문자열과 false 도 값으로 친다', () => {
    expect(
      availableOptionalFields(
        { ...base, type: 'cargo', subcommand: 'run', features: '', release: false },
        { springBoot: false },
        new Set()
      )
    ).toEqual(['args', 'cwd', 'env'])
  })

  it('Boot 프로젝트의 gradle 구성에는 springProfiles 가 오른다', () => {
    expect(
      availableOptionalFields({ ...base, type: 'gradle', tasks: 'bootRun' }, { springBoot: true }, new Set())
    ).toEqual(['javaHome', 'springProfiles', 'args', 'cwd', 'env'])
  })
})
