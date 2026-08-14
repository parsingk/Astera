import { describe, it, expect } from 'vitest'
import { migrateRunConfigs } from './migrate'

describe('migrateRunConfigs', () => {
  it('type 이 없는 v1 항목을 shell 로 읽는다 — 무손실', () => {
    const out = migrateRunConfigs([
      { id: 'user:1', name: 'dist', command: 'npm run dist', cwd: 'sub', env: { A: '1' } }
    ])
    expect(out).toEqual([
      { id: 'user:1', name: 'dist', type: 'shell', command: 'npm run dist', cwd: 'sub', env: { A: '1' } }
    ])
  })

  it('JAVA_HOME 과 SPRING_PROFILES_ACTIVE 는 env 에 그대로 남는다', () => {
    // v1 구성은 shell 이 되고, shell 에는 그 두 필드가 없으므로 승격할 자리가 없다
    const out = migrateRunConfigs([
      {
        id: 'user:2',
        name: 'boot',
        command: 'gradlew bootRun',
        env: { JAVA_HOME: 'C:\\jdk21', SPRING_PROFILES_ACTIVE: 'local' }
      }
    ])
    expect(out[0]).toMatchObject({
      type: 'shell',
      env: { JAVA_HOME: 'C:\\jdk21', SPRING_PROFILES_ACTIVE: 'local' }
    })
  })

  it('이미 type 이 있는 v2 항목은 그대로 통과시킨다', () => {
    const v2 = { id: 'user:3', name: 'dev', type: 'npm', script: 'dev' }
    expect(migrateRunConfigs([v2])).toEqual([v2])
  })

  it('손상된 항목은 조용히 버린다', () => {
    const out = migrateRunConfigs([
      { id: 'ok', name: 'ok', command: 'ls' },
      { id: 'no-name', command: 'ls' }, // name 없음
      { name: 'no-id', command: 'ls' }, // id 없음
      { id: 'bad-env', name: 'x', command: 'ls', env: { A: 3 } }, // env 값이 문자열이 아님
      'not an object',
      null
    ])
    expect(out.map((c) => c.id)).toEqual(['ok'])
  })

  // 이 함수는 run.saveConfig 의 관문이기도 하다. 이름은 트리와 실행 위젯 선택기에서 그 구성을
  // 가리키는 유일한 표시라, 빈 이름은 아무도 못 보고 못 누르는 행이 된다
  it('이름이 비었거나 공백뿐이면 버린다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: '', command: 'ls' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: '   ', command: 'ls' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: '', type: 'npm', script: 'dev' }])).toEqual([])
  })

  it('id 가 비었거나 공백뿐이면 버린다', () => {
    expect(migrateRunConfigs([{ id: '', name: 'x', command: 'ls' }])).toEqual([])
    expect(migrateRunConfigs([{ id: '  ', name: 'x', command: 'ls' }])).toEqual([])
  })

  it('배열이 아니면 빈 목록', () => {
    expect(migrateRunConfigs(null)).toEqual([])
    expect(migrateRunConfigs({})).toEqual([])
  })

  it('알 수 없는 type 은 버린다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'nope' }])).toEqual([])
  })

  it('종류의 필수 필드가 없으면 버린다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'npm' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'gradle', tasks: '' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'npm', script: 'dev' }])).toEqual([
      { id: 'x', name: 'x', type: 'npm', script: 'dev' }
    ])
  })

  it('python 은 file 이 필수다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'python' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'python', file: 'main.py' }])).toEqual([
      { id: 'x', name: 'x', type: 'python', file: 'main.py' }
    ])
  })

  // target 이 없어도(전체 실행) 통과한다 — pytest 에는 필수 필드가 없다
  it('pytest 는 필수 필드가 없다 — target 이 없어도 통과한다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'pytest' }])).toEqual([
      { id: 'x', name: 'x', type: 'pytest' }
    ])
  })

  // composeFile·services 모두 없어도(문맥의 파일, 전체 서비스) 통과한다 — compose 에는 필수 필드가 없다
  it('compose 는 필수 필드가 없다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'compose' }])).toEqual([
      { id: 'x', name: 'x', type: 'compose' }
    ])
  })
})
