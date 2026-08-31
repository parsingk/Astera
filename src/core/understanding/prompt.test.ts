import { describe, it, expect } from 'vitest'
import { EXPLANATION_CONTRACT, buildRecordPrompt } from './prompt'

describe('EXPLANATION_CONTRACT — 스펙 §24 의 계약이 온전한가', () => {
  // 조항을 빼면 그 구멍으로 도망간다 — 14개 번호와 §25 요지(7-1)가 전부 있어야 한다
  it('14개 규칙의 번호가 전부 들어 있다', () => {
    for (let n = 1; n <= 14; n++) expect(EXPLANATION_CONTRACT).toMatch(new RegExp(`^${n}\\. `, 'm'))
    expect(EXPLANATION_CONTRACT).toMatch(/^7-1\. /m) // §25 Vocabulary Guard
  })

  it('계약의 핵심 문장들이 원문 그대로다', () => {
    expect(EXPLANATION_CONTRACT).toContain('product manager')
    expect(EXPLANATION_CONTRACT).toContain('Do not invent behavior')
    expect(EXPLANATION_CONTRACT).toContain('grounded in supplied evidence')
    expect(EXPLANATION_CONTRACT).toContain('needs\n    review instead of guessing')
    expect(EXPLANATION_CONTRACT).toContain('chain-of-thought')
  })
})

describe('buildRecordPrompt', () => {
  const req = {
    request: '한도 대화상자를 못 알아보던 것을 고쳐줘',
    changedFiles: ['src/core/rolling/detect.ts', 'src/main/rolling.ts'],
    commits: ['fix(rolling): treat the dialog as the signal'],
    projectRoot: 'D:/p',
    lang: 'ko' as const
  }

  it('계약·요청·파일·커밋·출력 모양이 모두 실린다', () => {
    const p = buildRecordPrompt(req)
    expect(p).toContain(EXPLANATION_CONTRACT)
    expect(p).toContain('한도 대화상자를 못 알아보던 것을 고쳐줘')
    expect(p).toContain('- src/core/rolling/detect.ts')
    expect(p).toContain('fix(rolling): treat the dialog as the signal')
    expect(p).toContain('"userVisibleChanges"')
  })

  // What this prompt asks for is not the project — it's **one piece of work that just finished**
  it('작업 하나를 설명하라고 못박는다', () => {
    const p = buildRecordPrompt(req)
    expect(p).toContain('one piece of work that just finished')
    expect(p).toContain('never modify anything')
  })

  // The write-up sits on screen beside the app's own text. Without this the model chose a language
  // per run, and two records made two minutes apart came back in different ones.
  it('앱의 언어로 쓰라고 못박는다', () => {
    expect(buildRecordPrompt(req)).toContain('a person reads in Korean')
    expect(buildRecordPrompt({ ...req, lang: 'ja' })).toContain('a person reads in Japanese')
    // Paths and ids are not sentences — translating them would break the links they carry
    expect(buildRecordPrompt(req)).toContain('File paths, node ids')
  })

  it('읽기 예산을 준다 (스펙 §29)', () => {
    expect(buildRecordPrompt(req)).toContain('at most 10 files')
  })

  // A Job carries a task list and a validation outcome together; a session has no such section at all
  it('Job 의 재료가 있으면 싣고, 없으면 그 절이 없다', () => {
    expect(buildRecordPrompt(req)).not.toContain('Tasks in this run')
    const withJob = buildRecordPrompt({
      ...req,
      tasks: [{ title: '감지 고치기', outcome: 'completed' }],
      validation: { status: 'passed', summary: '테스트 4029개 통과' }
    })
    expect(withJob).toContain('Tasks in this run')
    expect(withJob).toContain('감지 고치기')
    expect(withJob).toContain('테스트 4029개 통과')
  })

  // A session's checks are the agent's own claim, not a measurement — the wording says so, and
  // the section is absent entirely when there is nothing to report (same rule as the Job section).
  it('보고된 검사와 요약이 실리고, 없으면 그 절이 없다', () => {
    expect(buildRecordPrompt(req)).not.toContain('What the agent reported running')
    expect(buildRecordPrompt(req)).not.toContain("The agent's own one-line summary")
    const withChecks = buildRecordPrompt({
      ...req,
      checks: [{ name: '단위 테스트', status: 'passed' }],
      resultSummary: '한도 감지를 고쳤다'
    })
    expect(withChecks).toContain('What the agent reported running')
    expect(withChecks).toContain('it said so; nobody measured it')
    expect(withChecks).toContain('- 단위 테스트: passed')
    expect(withChecks).toContain("The agent's own one-line summary")
    expect(withChecks).toContain('한도 감지를 고쳤다')
  })
})
