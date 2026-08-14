import { describe, it, expect } from 'vitest'
import { buildCommand, buildRunContext, quoteArg, hasUnsafeWin32Chars, type RunContext } from './build'

const ctx: RunContext = {
  packageManager: 'pnpm',
  gradleRunner: 'gradlew.bat',
  mavenRunner: 'mvnw.cmd',
  composeFile: null,
  platform: 'win32'
}
const posix: RunContext = { ...ctx, gradleRunner: './gradlew', mavenRunner: './mvnw', platform: 'linux' }
const base = { id: 'x', name: 'x' }

describe('buildCommand', () => {
  it('shell 은 명령을 그대로 쓴다', () => {
    expect(buildCommand({ ...base, type: 'shell', command: 'echo hi && echo bye' }, ctx))
      .toBe('echo hi && echo bye')
  })

  it('npm 은 auto 일 때 락파일이 고른 매니저를 쓴다', () => {
    expect(buildCommand({ ...base, type: 'npm', script: 'dev' }, ctx)).toBe('pnpm run dev')
    expect(buildCommand({ ...base, type: 'npm', script: 'dev', packageManager: 'yarn' }, ctx))
      .toBe('yarn run dev')
  })

  it('npm 의 args 는 뒤에 붙는다', () => {
    expect(buildCommand({ ...base, type: 'npm', script: 'test', args: '--watch' }, ctx))
      .toBe('pnpm run test --watch')
  })

  it('gradle 과 maven 은 문맥의 래퍼를 쓴다', () => {
    expect(buildCommand({ ...base, type: 'gradle', tasks: 'bootRun' }, ctx)).toBe('gradlew.bat bootRun')
    expect(buildCommand({ ...base, type: 'gradle', tasks: 'bootRun' }, posix)).toBe('./gradlew bootRun')
    expect(buildCommand({ ...base, type: 'maven', goals: 'spring-boot:run' }, ctx))
      .toBe('mvnw.cmd spring-boot:run')
  })

  it('cargo 의 release 와 features', () => {
    expect(buildCommand({ ...base, type: 'cargo', subcommand: 'run', release: true }, ctx))
      .toBe('cargo run --release')
    expect(buildCommand({ ...base, type: 'cargo', subcommand: 'test', features: 'a b' }, ctx))
      .toBe('cargo test --features "a b"')
  })

  it('go 는 패키지 경로가 없으면 . 을 쓴다', () => {
    expect(buildCommand({ ...base, type: 'go', subcommand: 'run' }, ctx)).toBe('go run .')
    expect(buildCommand({ ...base, type: 'go', subcommand: 'test', packagePath: './...' }, ctx))
      .toBe('go test ./...')
  })

  // node 의 file 과 같은 성격의 단일 경로값이므로 같은 대접을 받아야 한다
  it('go 의 패키지 경로에 공백이 있으면 인용한다', () => {
    expect(buildCommand({ ...base, type: 'go', subcommand: 'run', packagePath: './cmd/my app' }, ctx))
      .toBe('go run "./cmd/my app"')
  })

  it('node 는 파일 경로를 인용한다', () => {
    expect(buildCommand({ ...base, type: 'node', file: 'scripts/a b.js' }, ctx))
      .toBe('node "scripts/a b.js"')
    expect(buildCommand({ ...base, type: 'node', file: 'scripts/a b.js' }, posix))
      .toBe("node 'scripts/a b.js'")
  })

  it('python 은 인터프리터가 없으면 python 을 쓴다', () => {
    expect(buildCommand({ ...base, type: 'python', file: 'main.py' }, ctx)).toBe('python main.py')
    // nodePath 와 같은 성격의 단일 경로값이라 quoteArg 를 그대로 통과한다 — 공백이 있을 때만 감싸인다.
    // (공백 없는 경로는 감싸이지 않는다는 뜻이기도 하다: D:\p\.venv\Scripts\python.exe 에는 특수문자가
    // 없어 그대로 나간다 — 실제 venv 경로는 사용자 폴더 이름에 공백이 섞이는 경우가 흔해 이 분기가 실제로 쓰인다)
    expect(
      buildCommand(
        { ...base, type: 'python', file: 'main.py', interpreter: 'C:\\Program Files\\Python311\\python.exe' },
        ctx
      )
    ).toBe('"C:\\Program Files\\Python311\\python.exe" main.py')
  })

  it('pytest 는 -m pytest 로 부른다', () => {
    expect(buildCommand({ ...base, type: 'pytest' }, ctx)).toBe('python -m pytest')
    expect(buildCommand({ ...base, type: 'pytest', target: 'tests/unit' }, ctx))
      .toBe('python -m pytest tests/unit')
  })

  it('compose 는 문맥이 찾은 파일을 -f 로 넘긴다', () => {
    const c: RunContext = { ...ctx, composeFile: 'docker-compose.yml' }
    expect(buildCommand({ ...base, type: 'compose' }, c)).toBe('docker compose -f docker-compose.yml up')
    expect(buildCommand({ ...base, type: 'compose', services: 'web db', action: 'build' }, c))
      .toBe('docker compose -f docker-compose.yml build web db')
  })

  // composeFile 이 있으면 문맥의 것보다 우선한다 — 사용자가 명시한 값이 자동 감지를 이긴다
  it('compose 는 자신의 composeFile 을 문맥보다 우선한다', () => {
    const c: RunContext = { ...ctx, composeFile: 'docker-compose.yml' }
    expect(buildCommand({ ...base, type: 'compose', composeFile: 'compose.override.yml' }, c))
      .toBe('docker compose -f compose.override.yml up')
  })

  // 문맥에도 자신에게도 파일이 없으면 -f 없이 부른다 — docker compose 가 스스로 찾는다
  it('compose 파일이 전혀 없으면 -f 없이 부른다', () => {
    expect(buildCommand({ ...base, type: 'compose' }, ctx)).toBe('docker compose up')
  })
})

describe('quoteArg', () => {
  it('공백이 없으면 감싸지 않는다', () => {
    expect(quoteArg('dev', 'win32')).toBe('dev')
    expect(quoteArg('dev', 'linux')).toBe('dev')
  })

  it('빈 문자열은 빈 인자로 남긴다', () => {
    expect(quoteArg('', 'win32')).toBe('""')
    expect(quoteArg('', 'linux')).toBe("''")
  })

  // 두 셸의 인용이 다르다: sh 는 작은따옴표 안을 문자 그대로 읽고, cmd.exe 는 작은따옴표를
  // 인용으로 보지 않는다
  it('sh 는 작은따옴표, cmd.exe 는 큰따옴표', () => {
    expect(quoteArg('a b', 'linux')).toBe("'a b'")
    expect(quoteArg('a b', 'win32')).toBe('"a b"')
  })

  it('값 안의 따옴표를 각 셸의 방식으로 끊어 잇는다', () => {
    expect(quoteArg("it's", 'linux')).toBe("'it'\\''s'")
    expect(quoteArg('say "hi"', 'win32')).toBe('"say ""hi"""')
  })
})

describe('hasUnsafeWin32Chars', () => {
  // cmd.exe 는 & | ^ % ! < > 를 큰따옴표 안에서도 해석한다 — 조립으로 막을 수 없으니 저장을 거부한다
  it('cmd.exe 가 인용 안에서도 해석하는 문자를 잡는다', () => {
    expect(hasUnsafeWin32Chars('a&b')).toBe(true)
    expect(hasUnsafeWin32Chars('100%')).toBe(true)
    expect(hasUnsafeWin32Chars('a^b')).toBe(true)
    expect(hasUnsafeWin32Chars('a|b')).toBe(true)
  })

  it('평범한 경로는 통과시킨다', () => {
    expect(hasUnsafeWin32Chars('src/main/index.ts')).toBe(false)
    expect(hasUnsafeWin32Chars('C:\\Program Files\\Java')).toBe(false)
  })
})

describe('buildRunContext', () => {
  // Task 4가 detectSeedConfigs에서 이 규칙을 떼어내면서 테스트도 함께 지워졌다.
  // 규칙은 제품에 남아 있으므로 커버리지도 여기서 다시 선다
  it('Gradle 래퍼: 있으면 래퍼, 없으면 전역', () => {
    expect(buildRunContext(['gradlew'], 'linux').gradleRunner).toBe('./gradlew')
    expect(buildRunContext([], 'linux').gradleRunner).toBe('gradle')
    expect(buildRunContext(['gradlew.bat'], 'win32').gradleRunner).toBe('gradlew.bat')
    expect(buildRunContext([], 'win32').gradleRunner).toBe('gradle')
  })

  it('Maven 래퍼: 있으면 래퍼, 없으면 전역', () => {
    expect(buildRunContext(['mvnw'], 'linux').mavenRunner).toBe('./mvnw')
    expect(buildRunContext([], 'linux').mavenRunner).toBe('mvn')
    expect(buildRunContext(['mvnw.cmd'], 'win32').mavenRunner).toBe('mvnw.cmd')
    expect(buildRunContext([], 'win32').mavenRunner).toBe('mvn')
  })

  // posix의 래퍼는 반드시 './'가 붙어야 한다 — sh -c는 PATH만 뒤지므로 맨 이름은 못 찾는다
  it('posix 래퍼에는 ./ 가 붙는다', () => {
    expect(buildRunContext(['gradlew', 'mvnw'], 'darwin').gradleRunner.startsWith('./')).toBe(true)
    expect(buildRunContext(['gradlew', 'mvnw'], 'darwin').mavenRunner.startsWith('./')).toBe(true)
  })

  it('락파일이 패키지 매니저를 고른다', () => {
    expect(buildRunContext(['pnpm-lock.yaml'], 'win32').packageManager).toBe('pnpm')
    expect(buildRunContext([], 'win32').packageManager).toBe('npm')
  })

  it('platform을 그대로 실어 보낸다 — 인용이 이 값으로 갈린다', () => {
    expect(buildRunContext([], 'win32').platform).toBe('win32')
    expect(buildRunContext([], 'linux').platform).toBe('linux')
  })

  // 없으면 null — docker compose 가 스스로 찾도록 -f 를 아예 붙이지 않는다 (build.ts 의 compose 분기)
  it('compose 파일이 없으면 null', () => {
    expect(buildRunContext([], 'linux').composeFile).toBeNull()
  })

  it('compose 파일은 COMPOSE_FILE_NAMES 우선순위대로 고른다', () => {
    expect(buildRunContext(['docker-compose.yml', 'compose.yaml'], 'linux').composeFile).toBe('compose.yaml')
    expect(buildRunContext(['docker-compose.yml', 'docker-compose.yaml'], 'linux').composeFile).toBe(
      'docker-compose.yaml'
    )
    expect(buildRunContext(['docker-compose.yml'], 'linux').composeFile).toBe('docker-compose.yml')
  })
})
