// Every README names the command palette with the app's own word for it in that language and gives its key, the way
// src/core/github/readme.test.ts holds the GitHub lifecycle's words, so the README and the palette cannot drift apart.
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

describe('the READMEs and the command palette', () => {
  it.each(READMES)('%s names it as the app does, with its key', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(`**${CATALOGS[lang].messages['palette.title']}:**`)
    expect(text).toContain('`Ctrl`/`Cmd`+`Shift`+`P`')
  })
})
