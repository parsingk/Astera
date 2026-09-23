import { describe, it, expect } from 'vitest'
import { isOnlyTerminalReports } from './reports'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ST = ESC + '\\'

describe('isOnlyTerminalReports', () => {
  // xterm.js 가 스스로 pty 에 쓰는 것들이다 — 사람이 친 것이 아니다.
  it.each([
    ['focus in', `${ESC}[I`],
    ['focus out', `${ESC}[O`],
    ['DECXCPR (reply to ?6n)', `${ESC}[?12;40R`],
    ['DECXCPR with a page', `${ESC}[?12;40;1R`],
    ['DA1', `${ESC}[?1;2c`],
    ['DA2', `${ESC}[>0;276;0c`],
    ['DECRPM, private mode', `${ESC}[?2026;2$y`],
    ['DECRPM, ANSI mode', `${ESC}[4;2$y`],
    ['kitty keyboard flags', `${ESC}[?0u`],
    ['XTWINOPS cell size (reply to 16t)', `${ESC}[6;17;8t`],
    ['XTWINOPS text area', `${ESC}[8;30;100t`],
    ['DSR status', `${ESC}[0n`],
    ['OSC colour, BEL-terminated', `${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}`],
    ['OSC colour, ST-terminated', `${ESC}]10;rgb:d4d4/d4d4/d4d4${ST}`],
    ['XTVERSION (DCS)', `${ESC}P>|xterm.js(6.0.0)${ST}`],
    ['DA3 (DCS)', `${ESC}P!|00000000${ST}`],
    ['DECRQSS (DCS)', `${ESC}P1$r0m${ST}`]
  ])('%s is a report', (_name, data) => {
    expect(isOnlyTerminalReports(data)).toBe(true)
  })

  it('several reports in one write are still only reports', () => {
    expect(isOnlyTerminalReports(`${ESC}[O${ESC}[?0u${ESC}[?1;2c`)).toBe(true)
  })

  // 키 입력은 입력이다 — Esc 는 턴을 끊고, 화살표와 숫자와 Enter 는 대화상자에 답한다.
  it.each([
    ['Esc', ESC],
    ['Up', `${ESC}[A`],
    ['Down', `${ESC}[B`],
    ['Right', `${ESC}[C`],
    ['Left', `${ESC}[D`],
    ['Up in application cursor mode', `${ESC}OA`],
    ['Ctrl+Up', `${ESC}[1;5A`],
    ['Home', `${ESC}[H`],
    ['Delete', `${ESC}[3~`],
    ['F5', `${ESC}[15~`],
    ['Alt+P', `${ESC}P`],
    ['a digit', '1'],
    ['Enter', '\r'],
    ['text', 'next prompt'],
    ['a bracketed paste', `${ESC}[200~pasted${ESC}[201~`],
    ['a kitty-encoded key', `${ESC}[97;5u`],
    // 클릭이 대화상자에 답할 수 있다 — 틀려도 unknown 쪽으로 틀리게 센다.
    ['an SGR mouse report', `${ESC}[<0;10;5M`],
    // Shift+F3 과 겉모습이 같다 — ?6n 의 답(? 가 붙는다)만 보고로 친다.
    ['a CPR without the DEC marker', `${ESC}[1;2R`],
    ['a report followed by a keystroke', `${ESC}[Ox`],
    ['empty', '']
  ])('%s counts as input', (_name, data) => {
    expect(isOnlyTerminalReports(data)).toBe(false)
  })
})
