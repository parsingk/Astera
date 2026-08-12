import { describe, it, expect } from 'vitest'
import { BusyScanner } from './busy'

// OSC 0 제목 시퀀스 헬퍼 (BEL 종료)
const title = (t: string): string => `\x1b]0;${t}\x07`
const titleST = (t: string): string => `\x1b]0;${t}\x1b\\` // ST 종료 변형
const SPIN = '\u2802' // ⠂ 점자 스피너 프레임 (작업 중)
const SPIN2 = '\u2810' // ⠐
const IDLE = '\u2733' // ✳ 유휴/완료

describe('BusyScanner', () => {
  it('초기 상태는 유휴(false)이고, 제목이 없으면 그대로 false', () => {
    const s = new BusyScanner()
    expect(s.push('hello world\r\n')).toBe(false)
  })

  it('점자 스피너로 시작하는 제목이면 작업 중(true)', () => {
    const s = new BusyScanner()
    expect(s.push(title(`${SPIN} 1부터 10까지 출력`))).toBe(true)
  })

  it('✳로 시작하는 제목이면 유휴(false)', () => {
    const s = new BusyScanner()
    s.push(title(`${SPIN} 작업`)) // 먼저 작업 중으로
    expect(s.push(title(`${IDLE} 작업`))).toBe(false)
  })

  it('상태 문자가 아닌 일반 제목(claude, 경로 등)은 유휴로 본다', () => {
    const s = new BusyScanner()
    expect(s.push(title('claude'))).toBe(false)
    expect(s.push(title('C:\\WINDOWS\\SYSTEM32\\cmd.exe'))).toBe(false)
  })

  it('작업중→완료 전이: 점자 다음 ✳', () => {
    const s = new BusyScanner()
    expect(s.push(title(`${SPIN} p`))).toBe(true)
    expect(s.push(title(`${SPIN2} p`))).toBe(true) // 애니메이션 프레임 갱신 — 계속 작업 중
    expect(s.push(title(`${IDLE} p`))).toBe(false)
  })

  it('한 청크에 제목이 여러 개면 마지막 제목의 상태를 쓴다', () => {
    const s = new BusyScanner()
    expect(s.push(title(`${SPIN} a`) + 'output' + title(`${IDLE} a`))).toBe(false)
  })

  it('OSC가 청크 경계에서 잘려도 이어붙여 감지한다', () => {
    const s = new BusyScanner()
    const seq = title(`${SPIN} 나뉜 제목`)
    const cut = Math.floor(seq.length / 2)
    expect(s.push(seq.slice(0, cut))).toBe(false) // 아직 미완결 — 이전 상태(초기 false) 유지
    expect(s.push(seq.slice(cut))).toBe(true) // 완결 → 작업 중
  })

  it('OSC 2(제목) 및 ST 종료 변형도 인식한다', () => {
    const s = new BusyScanner()
    expect(s.push(`\x1b]2;${SPIN} x\x07`)).toBe(true)
    expect(s.push(titleST(`${IDLE} x`))).toBe(false)
  })

  it('상태 문자 앞 공백이 있어도 첫 실제 글자로 판정한다', () => {
    const s = new BusyScanner()
    expect(s.push(title(`  ${SPIN} p`))).toBe(true)
  })
})
