import { describe, it, expect } from 'vitest'
import { COMPOSE_FILE_NAMES, parseComposeServices } from './compose'

describe('parseComposeServices', () => {
  // 전체 YAML 파서를 들이지 않는다 — 필요한 것은 services 아래 한 단계의 키뿐이다
  it('services 아래 한 단계의 키를 읽는다', () => {
    const yaml = [
      'version: "3"',
      'services:',
      '  web:',
      '    image: nginx',
      '  db:',
      '    image: postgres',
      'volumes:',
      '  data:'
    ].join('\n')
    expect(parseComposeServices(yaml)).toEqual(['web', 'db'])
  })

  it('services 가 없으면 빈 목록', () => {
    expect(parseComposeServices('version: "3"')).toEqual([])
  })

  it('주석과 빈 줄을 건너뛴다', () => {
    const yaml = ['services:', '  # 주석', '', '  web:', '    image: nginx'].join('\n')
    expect(parseComposeServices(yaml)).toEqual(['web'])
  })

  // 주석이 서비스 자체를 지워도(들여쓰기가 서비스 키와 같아도) 첫 키로 잡히지 않는다 — 주석 판정이
  // 들여쓰기 판정보다 먼저 실행되기 때문
  it('주석 처리된 서비스는 들여쓰기 기준을 잡지 않고 건너뛴다', () => {
    const yaml = ['services:', '  # web:', '  #   image: nginx', '  db:', '    image: postgres'].join('\n')
    expect(parseComposeServices(yaml)).toEqual(['db'])
  })

  // 계획의 예시는 서비스 2칸/중첩 4칸 조합 하나만 검증한다. 들여쓰기 폭 자체를 다르게 해서, 첫 서비스
  // 키의 폭을 잠그는 로직이 특정 폭에 우연히 맞은 게 아니라 일반적으로 동작하는지 확인한다
  it('서비스 들여쓰기 폭이 달라도 첫 키의 폭을 기준으로 중첩 키를 가려낸다', () => {
    const yaml = ['services:', '    web:', '      image: nginx', '    db:', '      build:', '        context: .'].join(
      '\n'
    )
    expect(parseComposeServices(yaml)).toEqual(['web', 'db'])
  })

  // services: 가 0칸이 아니면(표준 compose 파일 형태가 아니면) 인식하지 않는다 — 잘못 판정해서 엉뚱한
  // 이름을 돌려주는 것보다, 빈 목록으로 안전하게 떨어지는 쪽이 낫다
  it('services: 가 0칸이 아니면 인식하지 않고 빈 목록을 돌려준다', () => {
    const yaml = ['x:', '  services:', '    web:', '      image: nginx'].join('\n')
    expect(parseComposeServices(yaml)).toEqual([])
  })

  // 파싱 실패의 대가가 작다는 설계 전제 자체를 검증한다: YAML 이 아닌 내용을 줘도 던지지 않고 빈
  // 목록으로 떨어져야, buildCommand 가 전체 프로젝트 실행으로 안전하게 후퇴한다
  it('YAML 이 아닌 내용을 줘도 던지지 않고 빈 목록으로 떨어진다', () => {
    expect(parseComposeServices('\x00 not yaml at all {{{')).toEqual([])
  })
})

describe('COMPOSE_FILE_NAMES', () => {
  it('네 이름을 우선순위대로 본다', () => {
    expect(COMPOSE_FILE_NAMES).toEqual([
      'compose.yaml',
      'compose.yml',
      'docker-compose.yaml',
      'docker-compose.yml'
    ])
  })
})
