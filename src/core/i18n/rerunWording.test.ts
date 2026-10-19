// The infrastructure rerun question names how many reruns the Job allowed (GitHub lifecycle G4, G7a): with Settings ›
// GitHub a Job may allow one, and "reran it 1 times" is not a sentence.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

describe('the rerun-spent question', () => {
  it('puts no count before a plural noun, in any language that has it', () => {
    for (const lang of LANGS) {
      const text = (CATALOGS[lang].messages as Record<string, string | undefined>)['jobs.gate.github.q.infraRerunSpent']
      if (text === undefined) continue
      expect(text, lang).toContain('{reruns}')
      expect(text, lang).not.toMatch(/\{reruns\} (times|veces|回)/)
    }
  })
})
