import { describe, it, expect } from 'vitest'
import {
  cycleViewMode, isMdViewMode, clampSplitRatio, langForFence,
  topForLine, lineForTop, toAnchors, SPLIT_DEFAULT, SPLIT_MIN, SPLIT_MAX
} from './markdownView'

describe('cycleViewMode', () => {
  it('editor → split → preview → editor 로 돈다', () => {
    expect(cycleViewMode('editor')).toBe('split')
    expect(cycleViewMode('split')).toBe('preview')
    expect(cycleViewMode('preview')).toBe('editor')
  })
})

describe('isMdViewMode', () => {
  it('세 값만 통과시킨다', () => {
    expect(isMdViewMode('split')).toBe(true)
    expect(isMdViewMode('editor')).toBe(true)
    expect(isMdViewMode('preview')).toBe(true)
    expect(isMdViewMode('other')).toBe(false)
    expect(isMdViewMode(null)).toBe(false)
    expect(isMdViewMode(undefined)).toBe(false)
    expect(isMdViewMode(0.5)).toBe(false)
  })
})

describe('clampSplitRatio', () => {
  it('범위 안의 값은 그대로 둔다', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5)
    expect(clampSplitRatio(0.2)).toBe(0.2)
  })
  it('범위 밖은 자른다', () => {
    expect(clampSplitRatio(0)).toBe(SPLIT_MIN)
    expect(clampSplitRatio(1)).toBe(SPLIT_MAX)
    expect(clampSplitRatio(-3)).toBe(SPLIT_MIN)
    expect(clampSplitRatio(99)).toBe(SPLIT_MAX)
  })
  // localStorage에서 온 값은 문자열이고, 사람이 고쳤거나 옛 버전이 쓴 쓰레기일 수 있다
  it('문자열 숫자를 받아들이고 그 밖은 기본값으로 되돌린다', () => {
    expect(clampSplitRatio('0.4')).toBe(0.4)
    expect(clampSplitRatio('')).toBe(SPLIT_DEFAULT)
    expect(clampSplitRatio('abc')).toBe(SPLIT_DEFAULT)
    expect(clampSplitRatio(null)).toBe(SPLIT_DEFAULT)
    expect(clampSplitRatio(undefined)).toBe(SPLIT_DEFAULT)
    expect(clampSplitRatio(NaN)).toBe(SPLIT_DEFAULT)
    expect(clampSplitRatio(Infinity)).toBe(SPLIT_DEFAULT)
  })
})

describe('langForFence', () => {
  it('별칭을 언어 키로 옮긴다', () => {
    expect(langForFence('ts')).toBe('javascript')
    expect(langForFence('typescript')).toBe('javascript')
    expect(langForFence('py')).toBe('python')
    expect(langForFence('python')).toBe('python')
    expect(langForFence('golang')).toBe('go')
    expect(langForFence('c++')).toBe('cpp')
  })
  it('대소문자를 무시하고 앞뒤 공백을 버린다', () => {
    expect(langForFence('  TS  ')).toBe('javascript')
    expect(langForFence('JSON')).toBe('json')
  })
  // ```ts title="foo.ts" 처럼 뒤에 메타가 붙는 관례가 널리 쓰인다
  it('첫 낱말만 본다', () => {
    expect(langForFence('ts title="foo.ts"')).toBe('javascript')
  })
  it('빈 info 와 모르는 언어는 null', () => {
    expect(langForFence('')).toBe(null)
    expect(langForFence('   ')).toBe(null)
    expect(langForFence('brainfuck')).toBe(null)
    // 이 저장소에는 셸용 CM6 언어 패키지가 없다. 색 없이 그린다
    expect(langForFence('bash')).toBe(null)
  })
  // 대괄호 lookup 이 Object.prototype 으로 새면 함수·객체가 LangKey 인 것처럼 돌아온다 — own() 이
  // 그것을 막는다(own() 이 없다면 이 두 값은 각각 Object 함수와 Object.prototype 이 되어 null 이
  // 아니게 된다)
  it("'constructor'·'__proto__' 는 Object.prototype 으로 새지 않고 null", () => {
    expect(langForFence('constructor')).toBe(null)
    expect(langForFence('__proto__')).toBe(null)
  })
})

describe('toAnchors', () => {
  it('빈 목록은 빈 목록', () => {
    expect(toAnchors([])).toEqual([])
  })
  it('항목이 하나면 그대로', () => {
    expect(toAnchors([{ line: 3, top: 30 }])).toEqual([{ line: 3, top: 30 }])
  })
  it('이미 오름차순이면 그대로', () => {
    const input = [{ line: 0, top: 0 }, { line: 5, top: 50 }, { line: 10, top: 100 }]
    expect(toAnchors(input)).toEqual(input)
  })
  it('뒤섞인 입력은 줄번호 오름차순으로 정렬한다', () => {
    const input = [{ line: 10, top: 100 }, { line: 0, top: 0 }, { line: 5, top: 50 }]
    expect(toAnchors(input)).toEqual([
      { line: 0, top: 0 },
      { line: 5, top: 50 },
      { line: 10, top: 100 }
    ])
  })
  it('같은 줄이 중복되면 문서 순서상 먼저 온(바깥) 것이 남는다', () => {
    const input = [{ line: 5, top: 10 }, { line: 5, top: 12 }, { line: 8, top: 40 }]
    expect(toAnchors(input)).toEqual([{ line: 5, top: 10 }, { line: 8, top: 40 }])
  })
  it('중복이 서로 떨어져 있어도(사이에 다른 줄이 끼어도) 먼저 온 것이 남는다', () => {
    const input = [{ line: 5, top: 10 }, { line: 7, top: 50 }, { line: 5, top: 99 }]
    expect(toAnchors(input)).toEqual([{ line: 5, top: 10 }, { line: 7, top: 50 }])
  })
  // data-md-line 이 숫자가 아니거나 비어 있으면 Number()가 NaN을 준다 — 그런 항목은 버린다
  it('줄번호가 유한수가 아니면 버린다', () => {
    const input = [{ line: 0, top: 0 }, { line: NaN, top: 5 }, { line: 10, top: 100 }]
    expect(toAnchors(input)).toEqual([{ line: 0, top: 0 }, { line: 10, top: 100 }])
  })
  // 닫힌 <details> 안의 모든 줄은 offsetTop 이 0(숨겨진 요소)이라 host.offsetTop 을 빼면 음수가 된다.
  // 줄번호는 계속 늘어나는데 top 이 그 구간에서 거꾸로 떨어지면 topForLine/lineForTop 의 한 방향
  // 훑기가 전제하는 "top 도 오름차순"이 깨진다 — 그 구간을 통째로 버려서 나머지가 오름차순을 유지한다
  it('top 이 직전보다 작아지는 항목(닫힌 <details> 등)은 버린다', () => {
    const input = [
      { line: 0, top: 0 },
      { line: 5, top: 100 },
      // <details> 안의 줄들 — 숨겨져 있어 top 이 음수로 떨어진다
      { line: 6, top: -20 },
      { line: 7, top: -18 },
      { line: 10, top: 300 }
    ]
    expect(toAnchors(input)).toEqual([
      { line: 0, top: 0 },
      { line: 5, top: 100 },
      { line: 10, top: 300 }
    ])
  })
  it('직전과 같은 top 은 버리지 않는다(내림차순만 막는다)', () => {
    const input = [{ line: 0, top: 10 }, { line: 5, top: 10 }, { line: 10, top: 20 }]
    expect(toAnchors(input)).toEqual(input)
  })
})

describe('topForLine', () => {
  const anchors = [
    { line: 0, top: 0 },
    { line: 10, top: 100 },
    { line: 20, top: 400 }
  ]
  it('앵커가 없으면 0', () => {
    expect(topForLine([], 5)).toBe(0)
  })
  it('앵커가 하나면 항상 그 top', () => {
    expect(topForLine([{ line: 7, top: 42 }], 0)).toBe(42)
    expect(topForLine([{ line: 7, top: 42 }], 99)).toBe(42)
  })
  it('앵커에 정확히 맞으면 그 top', () => {
    expect(topForLine(anchors, 0)).toBe(0)
    expect(topForLine(anchors, 10)).toBe(100)
    expect(topForLine(anchors, 20)).toBe(400)
  })
  it('사이는 선형보간한다', () => {
    expect(topForLine(anchors, 5)).toBe(50)
    expect(topForLine(anchors, 15)).toBe(250)
  })
  it('첫 앵커 위와 마지막 앵커 아래는 끝값에 붙는다', () => {
    expect(topForLine(anchors, -5)).toBe(0)
    expect(topForLine(anchors, 100)).toBe(400)
  })
})

describe('lineForTop', () => {
  const anchors = [
    { line: 0, top: 0 },
    { line: 10, top: 100 },
    { line: 20, top: 400 }
  ]
  it('앵커가 없으면 0', () => {
    expect(lineForTop([], 123)).toBe(0)
  })
  it('앵커에 정확히 맞으면 그 줄', () => {
    expect(lineForTop(anchors, 0)).toBe(0)
    expect(lineForTop(anchors, 100)).toBe(10)
    expect(lineForTop(anchors, 400)).toBe(20)
  })
  it('사이는 보간해 정수로 반올림한다', () => {
    expect(lineForTop(anchors, 50)).toBe(5)
    expect(lineForTop(anchors, 250)).toBe(15)
  })
  it('범위 밖은 끝값에 붙는다', () => {
    expect(lineForTop(anchors, -10)).toBe(0)
    expect(lineForTop(anchors, 9999)).toBe(20)
  })
  it('topForLine 과 왕복이 맞는다', () => {
    for (const line of [0, 3, 10, 17, 20])
      expect(lineForTop(anchors, topForLine(anchors, line))).toBe(line)
  })
})
