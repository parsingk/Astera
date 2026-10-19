// The GitHub lifecycle speaks in every language the app does (GitHub lifecycle design §8, G7c): every question a round
// can ask, every carry failure, the GitHub settings and badges, the Run's GitHub block and timeline, the New Job field.
// ko is the source; a key ko has under these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['jobs.gate.github.', 'github.', 'jobs.github.', 'jobs.event.github.', 'jobs.new.github', 'jobs.lifecycle.', 'jobs.convergence.node.ciWaiting']

describe('the GitHub lifecycle catalog', () => {
  it('has every lifecycle and GitHub key in every language', () => {
    const ko = Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))
    expect(ko.length).toBeGreaterThan(150)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })
})
