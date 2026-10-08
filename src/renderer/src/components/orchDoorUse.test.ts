// Remote runtime design Phase 7 (N10): the Job forms and the detail reach a Runtime only through the door
// (lib/orchDoor.ts), so a paired Runtime's Job never runs a command, an account probe or a run configuration read on
// this computer.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = (f: string): string => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')

describe('Job forms reach a Runtime only through the door', () => {
  it.each(['NewRunModal.tsx', 'NewTaskModal.tsx', 'RunDetail.tsx', 'CompletionBlock.tsx'])('%s calls no orchestration API directly', (f) => {
    expect(src(f)).not.toMatch(/window\.api\.(orch\.command|accounts\.list|accounts\.loginStatus|run\.list)\(/)
  })
})
