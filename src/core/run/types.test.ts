import { describe, it, expect } from 'vitest'
import { optionalFieldsFor } from './types'

describe('optionalFieldsFor', () => {
  it('모든 종류에 cwd 와 env 가 있다', () => {
    for (const t of [
      'shell', 'npm', 'node', 'gradle', 'maven', 'cargo', 'go', 'python', 'pytest', 'compose', 'dockerfile',
      'dotnet'
    ] as const) {
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
