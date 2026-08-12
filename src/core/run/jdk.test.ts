import { describe, it, expect } from 'vitest'
import { jdkSearchPaths, candidateJdkHome, parseJavaVersion, withJavaHomeOnPath } from './jdk'

describe('jdkSearchPaths', () => {
  it('win32: programFiles·localAppData·home이 모두 있으면 관례 디렉터리를 전부 스캔 대상에 넣는다', () => {
    const paths = jdkSearchPaths('win32', {
      javaHome: 'C:\\jdk-custom',
      programFiles: 'C:\\Program Files',
      localAppData: 'C:\\Users\\me\\AppData\\Local',
      home: 'C:\\Users\\me'
    })
    expect(paths.direct).toEqual(['C:\\jdk-custom'])
    expect(paths.scanParents).toEqual([
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Eclipse Adoptium',
      'C:\\Users\\me\\.gradle\\jdks'
    ])
  })

  it('posix: home이 있으면 sdkman·gradle jdks까지 스캔 대상에 넣는다', () => {
    const paths = jdkSearchPaths('linux', { home: '/home/me' })
    expect(paths.direct).toEqual([])
    expect(paths.scanParents).toEqual([
      '/usr/lib/jvm',
      '/Library/Java/JavaVirtualMachines',
      '/home/me/.sdkman/candidates/java',
      '/home/me/.gradle/jdks'
    ])
  })

  it('darwin도 posix 분기를 탄다 (/Library/Java/JavaVirtualMachines 포함)', () => {
    const paths = jdkSearchPaths('darwin', {})
    expect(paths.scanParents).toContain('/Library/Java/JavaVirtualMachines')
  })

  it('env 값이 없으면 해당 스캔 경로를 건너뛴다 (빈 문자열이 경로에 섞이지 않는다)', () => {
    expect(jdkSearchPaths('win32', {})).toEqual({ direct: [], scanParents: [] })
    expect(jdkSearchPaths('linux', {})).toEqual({
      direct: [],
      scanParents: ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
    })
  })

  it('javaHome만 있으면 direct에만 반영되고 scanParents는 영향받지 않는다', () => {
    const paths = jdkSearchPaths('win32', { javaHome: 'D:\\jdk-21' })
    expect(paths.direct).toEqual(['D:\\jdk-21'])
    expect(paths.scanParents).toEqual([])
  })
})

describe('candidateJdkHome', () => {
  it('일반 경로는 부모+자식을 그대로 잇는다', () => {
    expect(candidateJdkHome('C:\\Program Files\\Eclipse Adoptium', 'jdk-21.0.5+11', 'win32')).toBe(
      'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5+11'
    )
    expect(candidateJdkHome('/usr/lib/jvm', 'java-21-openjdk-amd64', 'linux')).toBe(
      '/usr/lib/jvm/java-21-openjdk-amd64'
    )
  })

  it('macOS JavaVirtualMachines 아래는 Contents/Home을 붙인다', () => {
    expect(
      candidateJdkHome('/Library/Java/JavaVirtualMachines', 'temurin-21.jdk', 'darwin')
    ).toBe('/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home')
  })

  // 실제로는 win32 스캔에 이 posix 경로가 나오지 않지만, 플랫폼 검사가 우선이라는 계약을 고정한다.
  it('같은 이름의 부모라도 win32에서는 보정하지 않는다', () => {
    expect(
      candidateJdkHome('/Library/Java/JavaVirtualMachines', 'temurin-21.jdk', 'win32')
    ).not.toContain('Contents')
  })
})

describe('parseJavaVersion', () => {
  it('JDK 9+ 출력을 파싱한다 (버전·벤더)', () => {
    const output = [
      'openjdk version "21.0.5" 2024-10-15 LTS',
      'OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)',
      'OpenJDK 64-Bit Server VM Temurin-21.0.5+11 (build 21.0.5+11-LTS, mixed mode, sharing)'
    ].join('\n')
    expect(parseJavaVersion(output)).toEqual({ version: '21.0.5', vendor: 'Temurin' })
  })

  it('JDK 8 구형식 출력을 파싱한다', () => {
    const output = [
      'java version "1.8.0_402"',
      'Java(TM) SE Runtime Environment (build 1.8.0_402-b06)',
      'Java HotSpot(TM) 64-Bit Server VM (build 25.402-b06, mixed mode)'
    ].join('\n')
    expect(parseJavaVersion(output)).toEqual({ version: '1.8.0_402', vendor: null })
  })

  it('벤더 표기가 없으면 vendor는 null이고 버전은 정상 취득한다', () => {
    const output = [
      'openjdk version "21.0.2" 2024-01-16',
      'OpenJDK Runtime Environment (build 21.0.2+13-58)',
      'OpenJDK 64-Bit Server VM (build 21.0.2+13-58, mixed mode, sharing)'
    ].join('\n')
    expect(parseJavaVersion(output)).toEqual({ version: '21.0.2', vendor: null })
  })

  it('Corretto·Zulu·GraalVM·Semeru 벤더를 인식한다', () => {
    expect(
      parseJavaVersion('openjdk version "21.0.5" \nOpenJDK Runtime Environment Corretto-21.0.5.11.1 (build 21.0.5+11-LTS)')
    ).toMatchObject({ vendor: 'Corretto' })
    expect(
      parseJavaVersion('openjdk version "21.0.2"\nOpenJDK Runtime Environment Zulu21.32+17-CA (build 21.0.2+13-CA)')
    ).toMatchObject({ vendor: 'Zulu' })
    expect(
      parseJavaVersion('openjdk version "21.0.2"\nOpenJDK Runtime Environment GraalVM CE 21.0.2+13.1 (build 21.0.2+13.1-jvmci-23.1-b19)')
    ).toMatchObject({ vendor: 'GraalVM' })
    // 실제 IBM Semeru 출력은 "Runtime Environment"가 아니라 "Runtime Open Edition"이라고 표기한다 —
    // Runtime Environment 줄로만 벤더를 찾으면 이 케이스를 못 잡는다 (parseJavaVersion 주석 참고).
    expect(
      parseJavaVersion('openjdk version "21.0.1" 2023-10-17\nIBM Semeru Runtime Open Edition 21.0.1.0 (build 21.0.1+12)')
    ).toMatchObject({ vendor: 'Semeru' })
  })

  it('쓰레기 입력은 null을 돌려준다', () => {
    expect(parseJavaVersion('')).toBeNull()
    expect(parseJavaVersion('command not found: java')).toBeNull()
    expect(parseJavaVersion('random garbage text without a version token')).toBeNull()
  })

  it('stderr에 섞인 경고 줄이 있어도 파싱된다', () => {
    const output = [
      'Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8',
      'openjdk version "17.0.9" 2023-10-17',
      'OpenJDK Runtime Environment Temurin-17.0.9+9 (build 17.0.9+9)',
      'OpenJDK 64-Bit Server VM Temurin-17.0.9+9 (build 17.0.9+9, mixed mode, sharing)'
    ].join('\n')
    expect(parseJavaVersion(output)).toEqual({ version: '17.0.9', vendor: 'Temurin' })
  })
})

describe('withJavaHomeOnPath', () => {
  it('win32: 기존 Path 키를 그대로 갱신하고 키를 새로 만들지 않는다', () => {
    const env = { Path: 'C:\\Windows;C:\\jdk-17\\bin', OTHER: 'x' }
    const out = withJavaHomeOnPath(env, 'C:\\jdk-21', 'win32')
    expect(out.Path).toBe('C:\\jdk-21\\bin;C:\\Windows;C:\\jdk-17\\bin')
    // PATH 키가 새로 생기면 자식이 어느 것을 볼지 불확실해진다 — 키 집합이 그대로여야 한다
    expect(Object.keys(out).sort()).toEqual(['OTHER', 'Path'])
  })

  it('대문자 PATH·소문자 path 어느 케이스든 그 키를 갱신한다', () => {
    const upper = withJavaHomeOnPath({ PATH: '/usr/bin' }, '/opt/jdk-21', 'linux')
    expect(Object.keys(upper)).toEqual(['PATH'])
    expect(upper.PATH).toBe('/opt/jdk-21/bin:/usr/bin')

    const lower = withJavaHomeOnPath({ path: '/usr/bin' }, '/opt/jdk-21', 'linux')
    expect(Object.keys(lower)).toEqual(['path'])
    expect(lower.path).toBe('/opt/jdk-21/bin:/usr/bin')
  })

  it('PATH 키가 아예 없으면 PATH를 새로 만든다', () => {
    const out = withJavaHomeOnPath({ HOME: '/root' }, '/opt/jdk-21', 'linux')
    expect(out.PATH).toBe('/opt/jdk-21/bin')
  })

  it('기존 PATH가 빈 문자열이면 구분자를 남기지 않는다', () => {
    const out = withJavaHomeOnPath({ PATH: '' }, '/opt/jdk-21', 'linux')
    expect(out.PATH).toBe('/opt/jdk-21/bin')
  })

  it('플랫폼별 구분자를 쓴다 — win32 세미콜론, posix 콜론', () => {
    expect(withJavaHomeOnPath({ PATH: 'A' }, 'C:\\jdk', 'win32').PATH).toBe('C:\\jdk\\bin;A')
    expect(withJavaHomeOnPath({ PATH: 'A' }, '/opt/jdk', 'darwin').PATH).toBe('/opt/jdk/bin:A')
  })

  it('JAVA_HOME 끝에 붙은 구분자를 정규화한다', () => {
    expect(withJavaHomeOnPath({ PATH: 'A' }, 'C:\\jdk\\', 'win32').PATH).toBe('C:\\jdk\\bin;A')
    expect(withJavaHomeOnPath({ PATH: 'A' }, '/opt/jdk//', 'linux').PATH).toBe('/opt/jdk/bin:A')
  })

  it('javaHome이 없거나 공백뿐이면 env를 그대로(같은 참조로) 돌려준다', () => {
    const env = { PATH: '/usr/bin' }
    expect(withJavaHomeOnPath(env, undefined, 'linux')).toBe(env)
    expect(withJavaHomeOnPath(env, '', 'linux')).toBe(env)
    expect(withJavaHomeOnPath(env, '   ', 'linux')).toBe(env)
  })

  it('원본 env를 변형하지 않는다', () => {
    const env = { Path: 'C:\\Windows' }
    withJavaHomeOnPath(env, 'C:\\jdk-21', 'win32')
    expect(env.Path).toBe('C:\\Windows')
  })
})
