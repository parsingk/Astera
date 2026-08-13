// 이 저장소 자신의 파일이 롤링을 오발화시키지 않는지 검사한다.
//
// 왜 필요한가: 롤링 세션 안에서 이 저장소의 파일이 화면으로 흐르는 일은 흔하다 — cat·tail·grep,
// 테스트 출력, 실패한 Edit이 되울리는 old_string, 에디터 렌더. 그 텍스트는 그대로 한도 스캐너에
// 들어가고(마지막 2000자 유지) 통짜로 적힌 한도 문구는 실제 한도와 구분되지 않는다. 결과는 두 단계다:
//   문구만            → 롤 오발화 (kill/respawn/전사 복사)
//   문구 + 선택지 라벨 → 거기에 더해 그 번호 + Enter를 세션에 쓴다 (answerLimitChoice, claude 전용).
//     화면의 선택지 배열은 [adjust, wait, upgrade]이고 항목 수가 계정 상태에 따라 달라져
//     (detect.ts) 문서에서 읽은 번호가 wait과 일치할 이유가 없다 — adjust(월 지출 한도 조정)를
//     누를 수 있고, 선택지가 없으면 그 숫자가 프롬프트에 타이핑돼 실행된다.
//
// **두 스캐너를 모두 돌린다.** 이 앱은 claude와 codex 세션을 각각 다른 스캐너로 롤링하며
// (detect.ts의 OutputScanner / codexSignal.ts의 CodexLimitScanner) 두 정규식이 인정하는 문구가
// 다르다. 한쪽으로만 검사하면 다른 쪽 전용 트리거가 통째로 남는다 — 이 티켓의 첫 시도가 실제로
// 그랬고, claude 트리거이기도 한 지점만 고쳐진 채 codex 전용 6곳이 남았다.
//
// 관례는 접합으로 쪼개는 것이다(rolling.test.ts의 LIMIT_TEXT). 런타임 값은 같고 소스에는
// 트리거가 없다. 이 검사가 없던 동안 세 번의 작업에서 매번 사람이 손으로
// 잡았고 그때마다 남은 것이 있었다 — 기계가 잡게 한다.
//
// 이 파일 자체도 검사 대상이다. 위반 보고에 매치된 문구를 담지 않는 것이 중요하다 — 담으면
// 실패 출력이 다시 트리거가 된다(과거에 vitest가 출력한 테스트 제목이 실제로 그랬다).
// 파일 경로와 위치만 담는다.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { OutputScanner, findWaitChoice } from '../core/rolling/detect'
import { CodexLimitScanner } from '../core/rolling/codexSignal'

const ROOT = process.cwd()
// .superpowers는 git-ignored 작업 공간이다 — SDD 진행 중 리뷰 diff가 그 안에 있고 diff는 당연히
// 원본의 문구를 담으므로, 검사 대상에 넣으면 브랜치 작업 중 항상 실패한다. 이것은 **알려진 잔여
// 위험을 수용하는 것**이며 안전하다는 뜻이 아니다: 실측 오탐 하나가 실제로 그 디렉토리의
// 리뷰 산출물이었다. git 히스토리에 남지 않는다는 것과 디스크에 있는 동안 라이브 세션을 흔들 수
// 있다는 것은 다른 문제고, 후자는 이미 한 번 일어났다. out·dist·release는 빌드 산출물로 소스에서
// 생성되며, 소스가 깨끗하면 번들도 깨끗하다.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.superpowers',
  '.worktrees',
  'coverage'
])
const EXTS = /\.(md|ts|tsx|js|cjs|mjs|json|txt|yml|yaml)$/
// 창(2000자)이 파일 전체를 촘촘히 슬라이딩하도록 작게 흘린다. 실제 PTY 청크는 이보다 커서
// 창이 덜 만들어지므로, 여기서 깨끗하면 실제 경로에서도 깨끗하다.
const CHUNK = 400

function collect(dir: string, out: string[]): string[] {
  let ents
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(path.join(dir, e.name), out)
    } else if (EXTS.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

/** 한 청크를 흘리고 한도가 발화했는지 본다. 발화하면 그 시점 누적 텍스트(선택지 파싱용),
 *  아니면 null. codex 스캐너는 boolean만 주므로 텍스트가 빈 문자열이다 — 선택지 해제는
 *  claude 전용 기능이라 codex 경로에서는 필요하지 않다. */
interface Probe {
  label: 'claude' | 'codex'
  feed(chunk: string): { text: string } | null
}

function makeProbes(): Probe[] {
  const claude = new OutputScanner()
  const codex = new CodexLimitScanner()
  return [
    {
      label: 'claude',
      feed: (c) => {
        const h = claude.push(c)
        return h.limit ? { text: h.text } : null
      }
    },
    {
      label: 'codex',
      feed: (c) => (codex.push(c) ? { text: '' } : null)
    }
  ]
}

interface Violation {
  file: string
  scanner: 'claude' | 'codex'
  /** 문구가 발화한 지점까지 흘린 바이트 오프셋 — 대략의 위치 */
  atOffset: number
  /** 같은 창에서 선택지 번호까지 잡혔다면 그 번호. null이면 롤 오발화만. */
  pressesChoice: number | null
}

function scan(file: string): Violation[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  if (!/limit/i.test(text)) return [] // 빠른 배제 — 두 정규식 모두 limit을 요구한다
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const found: Violation[] = []
  for (const probe of makeProbes()) {
    for (let i = 0; i < text.length; i += CHUNK) {
      const hit = probe.feed(text.slice(i, i + CHUNK))
      if (!hit) continue
      found.push({
        file: rel,
        scanner: probe.label,
        atOffset: Math.min(i + CHUNK, text.length),
        pressesChoice: findWaitChoice(hit.text)
      })
    }
  }
  return found
}

describe('저장소 자신의 파일이 롤링을 오발화시키지 않는다', () => {
  const files = collect(ROOT, [])
  const violations = files.flatMap(scan)

  it('스캔 대상 파일을 실제로 찾았다 — 목록이 비면 검사가 조용히 무력해진다', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('선택지 번호까지 눌리는 지점이 없다', () => {
    // 가장 심각한 등급 — 세션에 실제 키 입력이 들어간다. 따로 단정해 실패 메시지에서 바로 보이게 한다.
    expect(violations.filter((v) => v.pressesChoice !== null)).toEqual([])
  })

  it('claude 롤을 오발화시키는 지점이 없다', () => {
    expect(violations.filter((v) => v.scanner === 'claude')).toEqual([])
  })

  it('codex 롤을 오발화시키는 지점이 없다', () => {
    expect(violations.filter((v) => v.scanner === 'codex')).toEqual([])
  })
})
