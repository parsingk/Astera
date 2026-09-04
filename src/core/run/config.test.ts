import { describe, it, expect } from 'vitest'
import {
  detectPackageManager,
  detectSeedConfigs,
  mergeConfigs,
  seedKeyOf,
  promoteSeed,
  parseEnvLines,
  formatEnvLines,
  isSpringBootProject,
  hasDockerfile,
  defaultConfigFor,
  defaultDotnetProject,
  toRelativeCwd,
  type RunConfig,
  type RunConfigType
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

describe('promoteSeed', () => {
  it('시드를 사용자 구성 사본으로 만든다', () => {
    const seed = { id: 'seed:npm:dev', name: 'dev', type: 'npm' as const, script: 'dev' }
    const promoted = promoteSeed(seed, 'user:abc')
    expect(promoted).toEqual({ id: 'user:abc', name: 'dev', type: 'npm', script: 'dev' })
  })

  it('승격된 사본이 원래 시드를 목록에서 가린다', () => {
    // IntelliJ 의 임시 구성과 같은 규칙 — 기울임으로 있다가 손대면 정식 구성이 된다
    const seed = { id: 'seed:npm:dev', name: 'dev', type: 'npm' as const, script: 'dev' }
    const promoted = promoteSeed(seed, 'user:abc')
    expect(mergeConfigs([seed], [promoted]).map((c) => c.id)).toEqual(['user:abc'])
  })
})

describe('defaultConfigFor', () => {
  // ＋ 는 종류를 고르는 순간 저장한다(run.saveConfigs 의 allowIncomplete). 그래서 새 구성이 시드와 같은
  // 정체로 태어나면 mergeConfigs 가 그 시드를 그 자리에서 목록에서 빼 버린다 — 아직 아무것도 입력하지
  // 않았고 되돌릴 방법도 없다. 아래는 "누르기 전 목록"과 "누른 뒤 목록"을 실제로 만들어 비교한다.
  const npmSeeds = detectSeedConfigs(['package.json'], {
    ...noTexts,
    packageJson: JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } })
  })

  it('＋ npm 이 감지된 npm 구성을 목록에서 밀어내지 않는다', () => {
    const before = mergeConfigs(npmSeeds, [])
    expect(before.map((c) => c.id)).toEqual(['seed:npm:dev', 'seed:npm:build'])
    const created = defaultConfigFor('npm', 'user:1', 'npm', before, ['dev', 'build'], [])
    // 예전에는 ['user:1', 'seed:npm:build'] — dev 행이 통째로 사라졌다
    expect(mergeConfigs(npmSeeds, [created]).map((c) => c.id)).toEqual([
      'user:1',
      'seed:npm:dev',
      'seed:npm:build'
    ])
  })

  it('npm 후보가 모두 시드면 빈 스크립트로 시작한다', () => {
    const created = defaultConfigFor('npm', 'user:1', 'npm', mergeConfigs(npmSeeds, []), ['dev', 'build'], [])
    expect(created).toEqual({ id: 'user:1', name: 'npm', type: 'npm', script: '' })
  })

  it('시드가 없는 스크립트가 있으면 그것으로 시작한다', () => {
    // npmScripts 는 목록의 npm 구성에서 모으므로 package.json 에 없는 스크립트도 들어 있을 수 있다
    const stored: RunConfig[] = [{ id: 'user:1', name: 'lint', type: 'npm', script: 'lint' }]
    const list = mergeConfigs(npmSeeds, stored)
    const created = defaultConfigFor('npm', 'user:2', 'npm', list, ['dev', 'build', 'lint'], [])
    expect(created).toEqual({ id: 'user:2', name: 'npm', type: 'npm', script: 'lint' })
  })

  it('＋ cargo·go 가 감지된 run 구성을 밀어내지 않는다', () => {
    const seeds = detectSeedConfigs(['Cargo.toml', 'go.mod'], noTexts)
    const before = mergeConfigs(seeds, [])
    expect(before.map((c) => c.id)).toEqual(['seed:cargo:run', 'seed:go:run'])
    const cargo = defaultConfigFor('cargo', 'user:1', 'Cargo', before, [], [])
    const go = defaultConfigFor('go', 'user:2', 'Go', before, [], [])
    expect(mergeConfigs(seeds, [cargo, go]).map((c) => c.id)).toEqual([
      'user:1',
      'user:2',
      'seed:cargo:run',
      'seed:go:run'
    ])
  })

  it('가릴 수 있는 것은 시드뿐이라 사용자 구성과 겹치는 것은 피하지 않는다', () => {
    // 저장 구성끼리는 정체가 같아도 둘 다 화면에 남는다 — mergeConfigs 는 시드 쪽만 걸러낸다
    const stored: RunConfig[] = [{ id: 'user:1', name: 'Cargo', type: 'cargo', subcommand: 'run' }]
    const created = defaultConfigFor('cargo', 'user:2', 'Cargo', stored, [], [])
    expect(created).toEqual({ id: 'user:2', name: 'Cargo', type: 'cargo', subcommand: 'run' })
    expect(mergeConfigs([], [...stored, created]).map((c) => c.id)).toEqual(['user:1', 'user:2'])
  })

  it('시드가 없는 프로젝트의 시작값을 열세 종류 모두 못박는다', () => {
    const START: Record<RunConfigType, RunConfig> = {
      shell: { id: 'x', name: 'n', type: 'shell', command: '' },
      npm: { id: 'x', name: 'n', type: 'npm', script: 'dev' },
      node: { id: 'x', name: 'n', type: 'node', file: '' },
      gradle: { id: 'x', name: 'n', type: 'gradle', tasks: '' },
      maven: { id: 'x', name: 'n', type: 'maven', goals: '' },
      cargo: { id: 'x', name: 'n', type: 'cargo', subcommand: 'run' },
      go: { id: 'x', name: 'n', type: 'go', subcommand: 'run' },
      python: { id: 'x', name: 'n', type: 'python', file: '' },
      pytest: { id: 'x', name: 'n', type: 'pytest' },
      compose: { id: 'x', name: 'n', type: 'compose' },
      dockerfile: { id: 'x', name: 'n', type: 'dockerfile', imageTag: '' },
      dotnet: { id: 'x', name: 'n', type: 'dotnet', project: 'src/App/App.csproj' },
      compound: { id: 'x', name: 'n', type: 'compound', members: [] }
    }
    for (const [type, expected] of Object.entries(START)) {
      expect(
        defaultConfigFor(type as RunConfigType, 'x', 'n', [], ['dev'], ['App.sln', 'src/App/App.csproj'])
      ).toEqual(expected)
    }
  })
})

describe('defaultDotnetProject', () => {
  // 스캐너는 알파벳순이라 루트 솔루션 파일이 첫 항목이 되기 쉽다. 새 구성의 하위 명령 기본값은 run 이고
  // `dotnet run --project App.sln` 은 SDK 가 거부한다 — "'App.sln'은(는) 유효한 프로젝트 파일이 아닙니다"
  it('솔루션보다 실제 프로젝트 파일을 고른다', () => {
    expect(defaultDotnetProject(['App.sln', 'src/App/App.csproj'])).toBe('src/App/App.csproj')
    expect(defaultDotnetProject(['App.sln', 'src/Lib/Lib.fsproj'])).toBe('src/Lib/Lib.fsproj')
  })

  it('프로젝트 파일이 여럿이면 목록의 첫 프로젝트 파일이다', () => {
    expect(defaultDotnetProject(['a/A.csproj', 'b/B.csproj'])).toBe('a/A.csproj')
  })

  // 솔루션 파일만 있는 저장소도 있다 — 아무것도 안 가리키는 구성보다는 솔루션을 가리키는 편이 낫다
  it('솔루션밖에 없으면 그것을 고른다', () => {
    expect(defaultDotnetProject(['App.sln'])).toBe('App.sln')
  })

  it('빈 목록이면 빈 문자열이다', () => {
    expect(defaultDotnetProject([])).toBe('')
  })
})

describe('seedKeyOf', () => {
  // node·maven·cargo·go 는 한 번도 확인된 적이 없었다. Record 로 열세 종류를 한 표에 못박아 둔다 —
  // 종류가 늘면 여기서 컴파일이 깨지므로 새 종류가 조용히 빠질 수 없다
  it('열세 종류의 정체 문자열을 못박는다', () => {
    const base = { id: 'x', name: 'x' }
    const cases: Record<RunConfigType, [RunConfig, string]> = {
      shell: [{ ...base, type: 'shell', command: 'ls -al' }, 'shell:ls -al'],
      npm: [{ ...base, type: 'npm', script: 'dev' }, 'npm:dev'],
      node: [{ ...base, type: 'node', file: 'server/app.js' }, 'node:server/app.js'],
      gradle: [{ ...base, type: 'gradle', tasks: 'bootRun' }, 'gradle:bootRun'],
      maven: [{ ...base, type: 'maven', goals: 'spring-boot:run' }, 'maven:spring-boot:run'],
      cargo: [{ ...base, type: 'cargo', subcommand: 'test' }, 'cargo:test'],
      go: [{ ...base, type: 'go', subcommand: 'run', packagePath: './cmd/api' }, 'go:run:./cmd/api'],
      python: [{ ...base, type: 'python', file: 'main.py' }, 'python:main.py'],
      pytest: [{ ...base, type: 'pytest', target: 'tests/unit' }, 'pytest:tests/unit'],
      compose: [
        { ...base, type: 'compose', composeFile: 'compose.yaml', services: 'web' },
        'compose:compose.yaml:web'
      ],
      dockerfile: [{ ...base, type: 'dockerfile', imageTag: 'astera:dev' }, 'dockerfile:astera:dev'],
      dotnet: [{ ...base, type: 'dotnet', project: 'src/App/App.csproj' }, 'dotnet:src/App/App.csproj:run'],
      compound: [{ ...base, type: 'compound', members: [] }, 'compound:x']
    }
    for (const [type, [config, key]] of Object.entries(cases)) expect(seedKeyOf(config), type).toBe(key)
  })

  // go 의 `?? '.'` 는 지워도 아무 테스트가 울지 않았지만 하는 일이 있다: 시드(packagePath 없음)와
  // 승격 사본이 같은 키여야 사본이 시드를 가린다. 없으면 같은 항목이 목록에 둘로 남는다
  it('go 는 packagePath 가 없으면 . 로 정체를 짓는다 — 승격 사본이 시드를 가려야 한다', () => {
    const seed: RunConfig = { id: 'seed:go:run', name: 'go run .', type: 'go', subcommand: 'run' }
    expect(seedKeyOf(seed)).toBe('go:run:.')
    expect(mergeConfigs([seed], [promoteSeed(seed, 'user:1')]).map((c) => c.id)).toEqual(['user:1'])
  })

  it('python 은 file, pytest 는 target(없으면 빈 문자열) 으로 정체를 짓는다', () => {
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'python', file: 'main.py' })).toBe('python:main.py')
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'pytest', target: 'tests/unit' })).toBe('pytest:tests/unit')
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'pytest' })).toBe('pytest:')
  })

  it('compose 는 composeFile 과 services 로 정체를 짓는다(둘 다 없으면 빈 문자열)', () => {
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'compose' })).toBe('compose::')
    expect(
      seedKeyOf({ id: 'x', name: 'x', type: 'compose', composeFile: 'docker-compose.yml', services: 'web' })
    ).toBe('compose:docker-compose.yml:web')
  })

  // 같은 프로젝트 파일로 run 과 test 를 따로 두는 게 흔하므로 하위 명령까지 정체에 넣는다(go 와 같은 이유)
  it('dotnet 은 프로젝트와 하위 명령(없으면 run) 으로 정체를 짓는다', () => {
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'dotnet', project: 'src/App/App.csproj' })).toBe(
      'dotnet:src/App/App.csproj:run'
    )
    expect(
      seedKeyOf({ id: 'x', name: 'x', type: 'dotnet', project: 'src/App/App.csproj', subcommand: 'test' })
    ).toBe('dotnet:src/App/App.csproj:test')
  })

  it('dockerfile 은 imageTag 로 정체를 짓는다', () => {
    expect(seedKeyOf({ id: 'x', name: 'x', type: 'dockerfile', imageTag: 'astera:dev' })).toBe(
      'dockerfile:astera:dev'
    )
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

describe('hasDockerfile', () => {
  it('루트에 Dockerfile 이 있으면 true', () => {
    expect(hasDockerfile(['Dockerfile', 'package.json'])).toBe(true)
  })
  it('없으면 false', () => {
    expect(hasDockerfile(['package.json'])).toBe(false)
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

describe('compound identity', () => {
  // Every other kind derives its identity from the parameter that makes it what it is, so a stored
  // configuration can hide the seed it duplicates. A compound has no such parameter and no seed can
  // ever be one, so it is its own identity — two identical compounds both stay on screen.
  it('two compounds with the same members have different identities', () => {
    const a: RunConfig = { id: 'a', name: 'All', type: 'compound', members: ['x', 'y'] }
    const b: RunConfig = { id: 'b', name: 'All too', type: 'compound', members: ['x', 'y'] }
    expect(seedKeyOf(a)).not.toBe(seedKeyOf(b))
  })

  it('a new compound starts with no members', () => {
    expect(defaultConfigFor('compound', 'id1', 'Compound', [], [], [])).toEqual({
      id: 'id1',
      name: 'Compound',
      type: 'compound',
      members: []
    })
  })
})
