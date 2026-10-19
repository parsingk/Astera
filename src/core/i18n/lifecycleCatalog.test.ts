// The GitHub lifecycle speaks in every language the app does (GitHub lifecycle design §8, G7c): every question a round
// can ask, every carry failure, the GitHub settings and badges, the Run's GitHub block and timeline, the New Job field.
// ko is the source; a key ko has under these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'
import type { EvidenceStatus } from '../understanding/types'

const PREFIXES = ['jobs.gate.github.', 'github.', 'jobs.github.', 'jobs.event.github.', 'jobs.new.github', 'jobs.lifecycle.', 'jobs.convergence.node.ciWaiting', 'hiw.github.']

describe('the GitHub lifecycle catalog', () => {
  it('has every lifecycle and GitHub key in every language', () => {
    const ko = Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))
    expect(ko.length).toBeGreaterThan(150)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // How It Works' GitHub block builds its keys from the record's statuses (G8): a Record over the union, so a new status
  // does not compile without being checked here
  it('has How It Works’ GitHub words for every status of every line', () => {
    const statuses = Object.keys({ passed: true, failed: true, skipped: true } satisfies Record<EvidenceStatus, true>)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      const missing = ['local', 'ci', 'review'].flatMap((line) => statuses.map((s) => `hiw.github.${line}.${s}`)).filter((k) => !messages[k])
      expect(missing, lang).toEqual([])
    }
  })
})
