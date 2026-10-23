// Agent profiles speak in every language the app does (Agent Profiles design §8). ko is the source: a key it has under
// these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.agentProfiles.', 'settings.tab.agentProfiles', 'agentProfiles.']

const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))

describe('the agent profiles catalog', () => {
  it('has every agent profile key in every language', () => {
    const ko = keysOf()
    expect(ko.length).toBeGreaterThan(30)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // The person's rule for what the app says: a sentence is rewritten rather than broken with a dash
  it('has no dash inside a sentence in any language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => /\s[—–-]\s/.test(m[k] ?? '')), lang).toEqual([])
    }
  })

  it('names the tab as the person chose, and keeps the Agents tab’s own name', () => {
    const names = { ko: '에이전트 프로필', en: 'Agent profiles', es: 'Perfiles de agente', ja: 'エージェントプロファイル' }
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(m['settings.tab.agentProfiles'], lang).toBe(names[lang])
    }
    expect(CATALOGS.ko.messages['settings.tab.agent']).toBe('에이전트')
  })
})
