import { describe, it, expect } from 'vitest'
import { migrateRunConfigs, missingRequiredFields, REQUIRED } from './migrate'
import type { RunConfig, RunConfigType } from './types'
import { ko } from '../i18n/messages/ko'

/** A valid configuration of every kind. A Record, so a thirteenth kind cannot be added without
 *  landing here — the hand-written arrays elsewhere in the suite skip a new kind silently. */
const COMPLETE: Record<RunConfigType, RunConfig> = {
  shell: { id: 'x', name: 'x', type: 'shell', command: 'ls' },
  npm: { id: 'x', name: 'x', type: 'npm', script: 'dev' },
  node: { id: 'x', name: 'x', type: 'node', file: 'server/app.js' },
  gradle: { id: 'x', name: 'x', type: 'gradle', tasks: 'build' },
  maven: { id: 'x', name: 'x', type: 'maven', goals: 'package' },
  cargo: { id: 'x', name: 'x', type: 'cargo', subcommand: 'run' },
  go: { id: 'x', name: 'x', type: 'go', subcommand: 'run' },
  python: { id: 'x', name: 'x', type: 'python', file: 'main.py' },
  pytest: { id: 'x', name: 'x', type: 'pytest' },
  compose: { id: 'x', name: 'x', type: 'compose' },
  dockerfile: { id: 'x', name: 'x', type: 'dockerfile', imageTag: 'astera:dev' },
  dotnet: { id: 'x', name: 'x', type: 'dotnet', project: 'src/App/App.csproj' }
}

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

  // 이 함수는 run.saveConfigs 의 관문이기도 하다. 이름은 트리와 실행 위젯 선택기에서 그 구성을
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

  // subcommand 가 없어도(run) 통과한다 — dotnet 의 필수 필드는 project 뿐이다
  it('dotnet 은 project 가 필수다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'dotnet' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'dotnet', project: 'src/App/App.csproj' }])).toEqual([
      { id: 'x', name: 'x', type: 'dotnet', project: 'src/App/App.csproj' }
    ])
  })

  it('dockerfile 은 imageTag 가 필수다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'dockerfile' }])).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'dockerfile', imageTag: 'astera:dev' }])).toEqual([
      { id: 'x', name: 'x', type: 'dockerfile', imageTag: 'astera:dev' }
    ])
  })

  // The switch is stored on the configuration and the file is hand-editable, so it gets the same
  // type check cwd and env already get — a truthy string would otherwise read as "on".
  describe('allowMultipleInstances', () => {
    it('a boolean passes through untouched', () => {
      const cfg = { ...COMPLETE.npm, allowMultipleInstances: true }
      expect(migrateRunConfigs([cfg])).toEqual([cfg])
      const off = { ...COMPLETE.npm, allowMultipleInstances: false }
      expect(migrateRunConfigs([off])).toEqual([off])
    })

    it('a non-boolean drops that item', () => {
      expect(migrateRunConfigs([{ ...COMPLETE.npm, allowMultipleInstances: 'yes' }])).toEqual([])
      expect(migrateRunConfigs([{ ...COMPLETE.npm, allowMultipleInstances: 1 }])).toEqual([])
    })
  })

  it('rejects a configuration whose folder is not a string', () => {
    expect(migrateRunConfigs([{ id: 'a', name: 'x', type: 'npm', script: 'dev', folder: 3 }])).toEqual([])
  })
})

// 다섯 종류(shell·node·maven·cargo·go)의 필수 필드는 한 번도 확인된 적이 없었다 — 그 다섯을 []
// 로 바꿔도 테스트가 모두 초록이었다. 그래서 표를 먼저 못박고, 동작은 그 표를 돌면서 본다:
// 표 없이 REQUIRED 를 돌기만 하면 []로 비운 종류에서 반복문이 그냥 비어 버려 또 초록이 된다
describe('REQUIRED — 열두 종류 전부', () => {
  it('종류마다 어떤 필드가 필수인지 못박는다', () => {
    expect(REQUIRED).toEqual({
      shell: ['command'],
      npm: ['script'],
      node: ['file'],
      gradle: ['tasks'],
      maven: ['goals'],
      cargo: ['subcommand'],
      go: ['subcommand'],
      python: ['file'],
      pytest: [],
      compose: [],
      dockerfile: ['imageTag'],
      dotnet: ['project']
    })
  })

  it('완전한 구성은 열두 종류 모두 통과한다', () => {
    for (const [type, config] of Object.entries(COMPLETE)) {
      expect(migrateRunConfigs([config]).map((c) => c.type), type).toEqual([type])
    }
  })

  it('필수 필드가 비었거나 없으면 그 종류는 버려진다', () => {
    for (const [type, config] of Object.entries(COMPLETE)) {
      for (const key of REQUIRED[type as RunConfigType]) {
        expect(migrateRunConfigs([{ ...config, [key]: '' }]), `${type}.${key} 가 빈 문자열`).toEqual([])
        expect(migrateRunConfigs([{ ...config, [key]: undefined }]), `${type}.${key} 가 없음`).toEqual([])
      }
    }
  })

  // ipc.ts 의 run.start 가 `run.field.${이름}` 으로 라벨을 찾아 메시지를 만든다. 문자열로 조립한
  // 키라 타입이 못 막으므로, 라벨이 없으면 t() 가 undefined 를 만지다 던진다
  it('REQUIRED 의 모든 필드 이름에 run.field.* 라벨이 있다', () => {
    for (const names of Object.values(REQUIRED)) {
      for (const name of names) {
        expect(Object.prototype.hasOwnProperty.call(ko, `run.field.${name}`), name).toBe(true)
      }
    }
  })
})

// run.saveConfigs 의 경로. 새 구성은 필수 필드가 빈 채로 태어나므로, 이걸 거부하면 그 구성은
// 렌더러의 pending 한 칸에만 살고 다음 ＋ 가 덮어써 사라진다 (실제로 그렇게 사라졌다)
describe('migrateRunConfigs — allowIncomplete', () => {
  it('빈 필수 필드를 통과시킨다', () => {
    for (const [type, config] of Object.entries(COMPLETE)) {
      for (const key of REQUIRED[type as RunConfigType]) {
        expect(
          migrateRunConfigs([{ ...config, [key]: '' }], { allowIncomplete: true }),
          `${type}.${key}`
        ).toEqual([{ ...config, [key]: '' }])
      }
    }
  })

  it('필드가 아예 없으면 그래도 버린다 — 느슨해지는 것은 "비었다" 뿐이다', () => {
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'npm' }], { allowIncomplete: true })).toEqual([])
    expect(
      migrateRunConfigs([{ id: 'x', name: 'x', type: 'node', file: 3 }], { allowIncomplete: true })
    ).toEqual([])
  })

  it('나머지 검사는 그대로다 — id·이름·env·알 수 없는 type', () => {
    const opts = { allowIncomplete: true }
    expect(migrateRunConfigs([{ id: '', name: 'x', type: 'npm', script: '' }], opts)).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: ' ', type: 'npm', script: '' }], opts)).toEqual([])
    expect(migrateRunConfigs([{ id: 'x', name: 'x', type: 'nope' }], opts)).toEqual([])
    expect(
      migrateRunConfigs([{ id: 'x', name: 'x', type: 'npm', script: 'dev', env: { A: 3 } }], opts)
    ).toEqual([])
  })
})

describe('missingRequiredFields', () => {
  it('완전한 구성은 빈 목록이다', () => {
    for (const [type, config] of Object.entries(COMPLETE)) {
      expect(missingRequiredFields(config), type).toEqual([])
    }
  })

  // run.start 가 이 이름으로 거부 메시지를 만든다 — INVALID_CONFIG 만 던지면 어느 칸을 채우라는
  // 말인지 화면에서 알 수 없다
  it('비어 있는 필수 필드의 이름을 돌려준다', () => {
    expect(missingRequiredFields({ id: 'x', name: 'x', type: 'dockerfile', imageTag: '' })).toEqual([
      'imageTag'
    ])
    expect(missingRequiredFields({ id: 'x', name: 'x', type: 'shell', command: '' })).toEqual(['command'])
    expect(missingRequiredFields({ id: 'x', name: 'x', type: 'dotnet', project: '' })).toEqual(['project'])
  })
})
