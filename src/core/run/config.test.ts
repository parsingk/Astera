import { describe, it, expect } from 'vitest'
import {
  detectPackageManager,
  detectSeedConfigs,
  mergeConfigs,
  seedKeyOf,
  parseEnvLines,
  formatEnvLines,
  isSpringBootProject,
  splitEnv,
  mergeEnv,
  toRelativeCwd,
  type RunConfig
} from './config'

const noTexts = { packageJson: null, buildGradle: null, pom: null }

describe('detectPackageManager', () => {
  it('락파일로 pm을 고른다 (없으면 npm)', () => {
    expect(detectPackageManager(['package.json'])).toBe('npm')
    expect(detectPackageManager(['pnpm-lock.yaml'])).toBe('pnpm')
    expect(detectPackageManager(['yarn.lock'])).toBe('yarn')
    expect(detectPackageManager(['bun.lockb'])).toBe('bun')
  })
})

describe('detectSeedConfigs', () => {
  it('package.json scripts를 npm 종류로 시드한다', () => {
    const pkg = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } })
    const seeds = detectSeedConfigs(['package.json', 'pnpm-lock.yaml'], { ...noTexts, packageJson: pkg })
    expect(seeds).toEqual([
      { id: 'seed:npm:dev', name: 'dev', type: 'npm', script: 'dev' },
      { id: 'seed:npm:build', name: 'build', type: 'npm', script: 'build' }
    ])
  })
  it('Cargo.toml·go.mod를 하위명령으로 시드한다', () => {
    expect(detectSeedConfigs(['Cargo.toml'], noTexts)).toEqual([
      { id: 'seed:cargo:run', name: 'cargo run', type: 'cargo', subcommand: 'run' }
    ])
    expect(detectSeedConfigs(['go.mod'], noTexts)).toEqual([
      { id: 'seed:go:run', name: 'go run .', type: 'go', subcommand: 'run' }
    ])
  })
  it('scripts 없거나 잘못된 package.json은 무시한다', () => {
    expect(detectSeedConfigs(['package.json'], { ...noTexts, packageJson: 'not json' })).toEqual([])
    expect(detectSeedConfigs(['package.json'], { ...noTexts, packageJson: JSON.stringify({}) })).toEqual([])
    expect(detectSeedConfigs([], noTexts)).toEqual([])
  })
  it('scripts가 배열이면 무시한다', () => {
    expect(
      detectSeedConfigs(['package.json'], { ...noTexts, packageJson: JSON.stringify({ scripts: ['a', 'b'] }) })
    ).toEqual([])
  })

  describe('Gradle', () => {
    it('Boot 아니면 build·test 순서로 시드한다', () => {
      const seeds = detectSeedConfigs(['build.gradle'], noTexts)
      expect(seeds).toEqual([
        { id: 'seed:gradle:build', name: 'build', type: 'gradle', tasks: 'build' },
        { id: 'seed:gradle:test', name: 'test', type: 'gradle', tasks: 'test' }
      ])
    })
    it('build.gradle 본문에 Spring Boot 플러그인이 있으면 bootRun·test·build 순으로 시드한다', () => {
      const buildGradle = "plugins { id 'org.springframework.boot' version '3.2.0' }"
      const seeds = detectSeedConfigs(['build.gradle'], { ...noTexts, buildGradle })
      expect(seeds.map((s) => [s.type, (s as { tasks: string }).tasks])).toEqual([
        ['gradle', 'bootRun'],
        ['gradle', 'test'],
        ['gradle', 'build']
      ])
    })
    it('build.gradle.kts만 있어도 Gradle로 인식한다', () => {
      const seeds = detectSeedConfigs(['build.gradle.kts'], noTexts)
      expect(seeds.map((s) => (s as { tasks: string }).tasks)).toEqual(['build', 'test'])
    })
    it('시드 id는 user:로 시작하지 않는다', () => {
      const seeds = detectSeedConfigs(['build.gradle'], noTexts)
      expect(seeds.every((s) => !s.id.startsWith('user:'))).toBe(true)
    })
  })

  describe('Maven', () => {
    it('Boot 아니면 package·test 순서로 시드한다', () => {
      const seeds = detectSeedConfigs(['pom.xml'], noTexts)
      expect(seeds).toEqual([
        { id: 'seed:maven:package', name: 'package', type: 'maven', goals: 'package' },
        { id: 'seed:maven:test', name: 'test', type: 'maven', goals: 'test' }
      ])
    })
    it('pom.xml 본문에 Spring Boot groupId가 있으면 spring-boot:run·test·package 순으로 시드한다', () => {
      const pom = '<dependency><groupId>org.springframework.boot</groupId></dependency>'
      const seeds = detectSeedConfigs(['pom.xml'], { ...noTexts, pom })
      expect(seeds.map((s) => (s as { goals: string }).goals)).toEqual(['spring-boot:run', 'test', 'package'])
    })
  })

  it('JVM 빌드 파일이 없는 프로젝트는 기존 동작 그대로다 (회귀 없음)', () => {
    const pkg = JSON.stringify({ scripts: { dev: 'vite' } })
    expect(detectSeedConfigs(['package.json'], { ...noTexts, packageJson: pkg })).toEqual([
      { id: 'seed:npm:dev', name: 'dev', type: 'npm', script: 'dev' }
    ])
  })
})

describe('detectSeedConfigs — 타입 있는 시드', () => {
  it('package.json 스크립트는 npm 종류로 시드된다', () => {
    const out = detectSeedConfigs(
      ['package.json', 'pnpm-lock.yaml'],
      { packageJson: '{"scripts":{"dev":"vite"}}', buildGradle: null, pom: null }
    )
    expect(out).toEqual([{ id: 'seed:npm:dev', name: 'dev', type: 'npm', script: 'dev' }])
  })

  it('시드 id 는 명령이 아니라 종류와 키로 만들어진다', () => {
    // 락파일이 바뀌어 명령이 달라져도 같은 구성으로 이어져야 한다 —
    // 이 id 가 "마지막에 쓴 구성" 의 키로도 쓰인다
    const npmSeed = detectSeedConfigs(
      ['package.json'],
      { packageJson: '{"scripts":{"dev":"vite"}}', buildGradle: null, pom: null }
    )
    const pnpmSeed = detectSeedConfigs(
      ['package.json', 'pnpm-lock.yaml'],
      { packageJson: '{"scripts":{"dev":"vite"}}', buildGradle: null, pom: null }
    )
    expect(npmSeed[0].id).toBe(pnpmSeed[0].id)
  })

  it('Gradle 은 gradle 종류로, Boot 이면 bootRun 이 먼저', () => {
    const out = detectSeedConfigs(
      ['build.gradle', 'gradlew.bat'],
      { packageJson: null, buildGradle: 'plugins { id "org.springframework.boot" }', pom: null }
    )
    expect(out.map((c) => [c.type, (c as { tasks: string }).tasks])).toEqual([
      ['gradle', 'bootRun'],
      ['gradle', 'test'],
      ['gradle', 'build']
    ])
  })

  it('cargo 와 go 는 하위명령으로 시드된다', () => {
    const cargo = detectSeedConfigs(['Cargo.toml'], { packageJson: null, buildGradle: null, pom: null })
    expect(cargo).toEqual([{ id: 'seed:cargo:run', name: 'cargo run', type: 'cargo', subcommand: 'run' }])
    const go = detectSeedConfigs(['go.mod'], { packageJson: null, buildGradle: null, pom: null })
    expect(go).toEqual([{ id: 'seed:go:run', name: 'go run .', type: 'go', subcommand: 'run' }])
  })
})

describe('mergeConfigs', () => {
  it('저장 구성 우선 + 명령 중복 시드 제외', () => {
    const stored: RunConfig[] = [{ id: 'u1', name: '내 dev', type: 'shell', command: 'pnpm run dev' }]
    const seed: RunConfig[] = [
      { id: 'seed:pnpm run dev', name: 'pnpm run dev', type: 'shell', command: 'pnpm run dev' },
      { id: 'seed:pnpm run build', name: 'pnpm run build', type: 'shell', command: 'pnpm run build' }
    ]
    expect(mergeConfigs(seed, stored)).toEqual([
      { id: 'u1', name: '내 dev', type: 'shell', command: 'pnpm run dev' },
      { id: 'seed:pnpm run build', name: 'pnpm run build', type: 'shell', command: 'pnpm run build' }
    ])
  })
})

describe('mergeConfigs — 종류와 핵심 매개변수로 충돌을 본다', () => {
  it('같은 종류·같은 스크립트의 사용자 구성이 시드를 가린다', () => {
    const seed = [{ id: 'seed:npm:dev', name: 'dev', type: 'npm' as const, script: 'dev' }]
    const stored = [{ id: 'user:1', name: '내 dev', type: 'npm' as const, script: 'dev', args: '--host' }]
    expect(mergeConfigs(seed, stored).map((c) => c.id)).toEqual(['user:1'])
  })

  it('스크립트가 다르면 둘 다 남는다', () => {
    const seed = [{ id: 'seed:npm:dev', name: 'dev', type: 'npm' as const, script: 'dev' }]
    const stored = [{ id: 'user:1', name: 'build', type: 'npm' as const, script: 'build' }]
    expect(mergeConfigs(seed, stored).map((c) => c.id)).toEqual(['user:1', 'seed:npm:dev'])
  })

  it('종류가 다르면 가리지 않는다', () => {
    const seed = [{ id: 'seed:npm:dev', name: 'dev', type: 'npm' as const, script: 'dev' }]
    const stored = [{ id: 'user:1', name: 'dev', type: 'shell' as const, command: 'npm run dev' }]
    expect(mergeConfigs(seed, stored).map((c) => c.id)).toEqual(['user:1', 'seed:npm:dev'])
  })
})

describe('seedKeyOf', () => {
  it('종류와 핵심 매개변수를 잇는다', () => {
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'npm', script: 'dev' })).toBe('npm:dev')
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'gradle', tasks: 'bootRun' })).toBe('gradle:bootRun')
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'shell', command: 'ls' })).toBe('shell:ls')
  })
})

describe('parseEnvLines', () => {
  it('기본 KEY=VALUE 줄을 맵으로 만든다', () => {
    expect(parseEnvLines('A=1\nB=2')).toEqual({ A: '1', B: '2' })
  })
  it('#으로 시작하는 줄은 주석으로 무시한다 (앞 공백 허용)', () => {
    expect(parseEnvLines('# comment\nA=1\n  # indented comment\nB=2')).toEqual({ A: '1', B: '2' })
  })
  it('빈 줄·공백만 있는 줄은 무시한다', () => {
    expect(parseEnvLines('A=1\n\n   \nB=2')).toEqual({ A: '1', B: '2' })
  })
  it('값에 =가 있으면 첫 =로만 분리한다', () => {
    expect(parseEnvLines('A=b=c')).toEqual({ A: 'b=c' })
  })
  it('=가 없는 줄은 조용히 버린다', () => {
    expect(parseEnvLines('NOEQUALS\nA=1')).toEqual({ A: '1' })
  })
  it('키·값 앞뒤 공백은 trim하지만 값 내부 공백은 보존한다', () => {
    expect(parseEnvLines('  A  =  hello world  ')).toEqual({ A: 'hello world' })
  })
  it('CRLF 줄바꿈도 처리한다', () => {
    expect(parseEnvLines('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' })
  })
  it('키가 빈 문자열이면 무시한다', () => {
    expect(parseEnvLines('=novalue\nA=1')).toEqual({ A: '1' })
  })
  it('빈 문자열은 빈 맵이 된다', () => {
    expect(parseEnvLines('')).toEqual({})
  })
})

describe('formatEnvLines', () => {
  it('맵을 KEY=VALUE 줄로 만든다', () => {
    expect(formatEnvLines({ A: '1', B: '2' })).toBe('A=1\nB=2')
  })
  it('undefined는 빈 문자열이 된다', () => {
    expect(formatEnvLines(undefined)).toBe('')
  })
  it('parseEnvLines와 왕복한다', () => {
    const env = { JAVA_HOME: 'C:/jdk-21', SPRING_PROFILES_ACTIVE: 'local' }
    expect(parseEnvLines(formatEnvLines(env))).toEqual(env)
  })
})

describe('isSpringBootProject', () => {
  it('buildGradle·pom 어느 쪽이든 Boot 마커가 있으면 true', () => {
    expect(isSpringBootProject({ buildGradle: "id 'org.springframework.boot'", pom: null })).toBe(true)
    expect(
      isSpringBootProject({ buildGradle: null, pom: '<groupId>org.springframework.boot</groupId>' })
    ).toBe(true)
  })
  it('둘 다 없거나 마커가 없으면 false', () => {
    expect(isSpringBootProject({ buildGradle: null, pom: null })).toBe(false)
    expect(isSpringBootProject({ buildGradle: "id 'java'", pom: null })).toBe(false)
  })
})

describe('splitEnv', () => {
  it('키가 없으면 picked는 빈 맵, rest는 원본과 같다', () => {
    expect(splitEnv({ A: '1' }, ['JAVA_HOME'])).toEqual({ picked: {}, rest: { A: '1' } })
  })
  it('일부 키만 있으면 그만큼만 picked로 분리한다', () => {
    expect(splitEnv({ JAVA_HOME: 'C:/jdk', A: '1' }, ['JAVA_HOME', 'SPRING_PROFILES_ACTIVE'])).toEqual({
      picked: { JAVA_HOME: 'C:/jdk' },
      rest: { A: '1' }
    })
  })
  it('env가 undefined면 picked·rest 모두 빈 맵', () => {
    expect(splitEnv(undefined, ['JAVA_HOME'])).toEqual({ picked: {}, rest: {} })
  })
  it('원본 env를 변형하지 않는다', () => {
    const env = { JAVA_HOME: 'C:/jdk', A: '1' }
    const snapshot = { ...env }
    splitEnv(env, ['JAVA_HOME'])
    expect(env).toEqual(snapshot)
  })
})

describe('mergeEnv', () => {
  it('picked의 빈 문자열·undefined 값은 버린다', () => {
    expect(mergeEnv({ JAVA_HOME: '' }, { A: '1' })).toEqual({ A: '1' })
    expect(mergeEnv({ JAVA_HOME: undefined }, { A: '1' })).toEqual({ A: '1' })
  })
  it('picked 값이 있으면 rest와 합친다', () => {
    expect(mergeEnv({ JAVA_HOME: 'C:/jdk' }, { A: '1' })).toEqual({ JAVA_HOME: 'C:/jdk', A: '1' })
  })
  it('rest에 같은 키가 있어도 picked가 이긴다 (textarea에 손으로 겹쳐 쓴 경우)', () => {
    expect(mergeEnv({ JAVA_HOME: 'C:/from-select' }, { JAVA_HOME: 'C:/typed-by-hand' })).toEqual({
      JAVA_HOME: 'C:/from-select'
    })
  })
  it('splitEnv와 왕복한다', () => {
    const env = { JAVA_HOME: 'C:/jdk-21', SPRING_PROFILES_ACTIVE: 'local', OTHER: '1' }
    const { picked, rest } = splitEnv(env, ['JAVA_HOME', 'SPRING_PROFILES_ACTIVE'])
    expect(mergeEnv(picked, rest)).toEqual(env)
  })
})

describe('toRelativeCwd', () => {
  it('프로젝트 하위 경로면 상대 경로로 바꾼다', () => {
    expect(toRelativeCwd('D:\\proj\\backend', 'D:\\proj')).toBe('backend')
    expect(toRelativeCwd('/home/me/proj/backend', '/home/me/proj')).toBe('backend')
  })
  it('프로젝트 루트 자신이면 빈 문자열', () => {
    expect(toRelativeCwd('D:\\proj', 'D:\\proj')).toBe('')
  })
  it('대소문자가 달라도 하위 경로로 인식한다 (win32 드라이브 문자·다이얼로그 경로차)', () => {
    expect(toRelativeCwd('d:\\Proj\\Backend', 'D:\\proj')).toBe('Backend')
  })
  it('프로젝트 밖이면 절대 경로를 그대로 돌려준다 (저장 시점에 거부되게)', () => {
    expect(toRelativeCwd('D:\\other', 'D:\\proj')).toBe('D:\\other')
  })
  it('형제 프리픽스를 하위 경로로 오인하지 않는다 (D:\\proj vs D:\\proj2)', () => {
    expect(toRelativeCwd('D:\\proj2\\backend', 'D:\\proj')).toBe('D:\\proj2\\backend')
  })
})
