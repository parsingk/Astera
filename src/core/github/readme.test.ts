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
})
