// The README presents the GitHub lifecycle in every language it is written in (GitHub lifecycle G8), naming the New Job
// switch and the settings page with the app's own words in that language, so the two cannot drift apart.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { CATALOGS, type Lang } from '../i18n'

const READMES: [string, Lang][] = [
  ['README.md', 'en'],
  ['README.ko.md', 'ko'],
  ['README.ja.md', 'ja'],
  ['README.es.md', 'es']
]

/** What the switch scopes, in each README (G8 final review M2): the Job it is on. Not the app's GitHub use as a whole —
 *  the same README's GitHub section pushes and opens pull requests without it, and the issue source reads GitHub. */
const SCOPE: Record<Lang, string> = {
  en: 'Only a Job that turns on',
  ko: '켠 Job만',
  ja: 'をオンにした Job だけ',
  es: 'Solo un Job que active'
}

describe('the README’s GitHub lifecycle entry', () => {
  it.each(READMES)('%s names the switch and Settings › GitHub as the app does', (file, lang) => {
    const readme = readFileSync(path.join(__dirname, '../../..', file), 'utf8')
    const messages = CATALOGS[lang].messages as Record<string, string>
    // The switch's name without its parenthesis: 'Carry it through GitHub (push, pull request, CI)'
    const toggle = messages['jobs.new.github'].split(/ \(|（/)[0]
    // The settings page, as the switch's hint names it: '… — Settings › GitHub'
    const settings = messages['jobs.new.githubDefaults'].split(' — ').pop()!
    expect(readme).toContain(`**${toggle}**`)
    expect(readme).toContain(settings)
    expect(readme).toContain('How It Works')
  })

  it.each(READMES)('%s says the switch carries the Job it is on, not that nothing else reaches GitHub', (file, lang) => {
    const readme = readFileSync(path.join(__dirname, '../../..', file), 'utf8').replace(/\s+/g, ' ')
    expect(readme).toContain(SCOPE[lang])
  })
})
