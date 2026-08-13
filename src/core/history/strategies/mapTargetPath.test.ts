// 대상 계정 폴더로의 세션 파일 경로 매핑. 단언은 core/rolling/transcript.test.ts의
// mapTranscriptTarget·mapRolloutTarget 테스트에서 그대로 옮겨 왔다 — 값이 바뀌면 동작이 바뀐 것이다.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { claudeHistoryStrategy } from './claude'
import { codexHistoryStrategy } from './codex'

describe('claudeHistoryStrategy.mapTargetPath', () => {
  it('슬러그 폴더·파일명을 원본에서 재사용해 대상 configDir 아래 경로를 만든다', () => {
    const src = path.join('C:\\Users\\me\\.claude', 'projects', 'D--work-app', 'abc-123.jsonl')
    expect(claudeHistoryStrategy.mapTargetPath(src, 'C:\\Users\\me\\.claude-accounts\\sub')).toBe(
      path.join('C:\\Users\\me\\.claude-accounts\\sub', 'projects', 'D--work-app', 'abc-123.jsonl')
    )
  })
})

describe('codexHistoryStrategy.mapTargetPath', () => {
  it('날짜 폴더 3단계·파일명을 원본에서 재사용해 대상 CODEX_HOME 아래 경로를 만든다', () => {
    const src = path.join(
      'C:\\Users\\me\\.codex',
      'sessions',
      '2026',
      '07',
      '09',
      'rollout-2026-07-09T00-00-00-019f4524-e0ac-7571-a8af-5585504f0d32.jsonl'
    )
    expect(codexHistoryStrategy.mapTargetPath(src, 'C:\\Users\\me\\.codex-accounts\\sub')).toBe(
      path.join(
        'C:\\Users\\me\\.codex-accounts\\sub',
        'sessions',
        '2026',
        '07',
        '09',
        'rollout-2026-07-09T00-00-00-019f4524-e0ac-7571-a8af-5585504f0d32.jsonl'
      )
    )
  })
})
