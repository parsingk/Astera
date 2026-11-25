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

  it.each(READMES)('%s names going to a file as the app does, with its key', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(`**${CATALOGS[lang].messages['shortcut.file.quickOpen']}:**`)
    expect(text).toContain('`Ctrl`/`Cmd`+`P`')
  })

  it.each(READMES)('%s names finding in files as the app does, with its key and what it leaves out', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(`**${CATALOGS[lang].messages['shortcut.search.text']}:**`)
    expect(text).toContain('`Ctrl`/`Cmd`+`Shift`+`F`')
    expect(text).toContain('`.ignore`')
  })

  it.each(READMES)('%s names the Problems tab as the app does, with its key', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(`**${CATALOGS[lang].messages['shortcut.problems.open']}:**`)
    expect(text).toContain('`Ctrl`/`Cmd`+`Shift`+`M`')
  })

  it.each(READMES)('%s names the layout actions as the app does', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    for (const id of ['coding', 'review', 'agents', 'devops', 'reset', 'presets'] as const) {
      expect(text).toContain(`**${CATALOGS[lang].messages[`shortcut.layout.${id}`]}**`)
    }
  })

  // Phase 1 gate: where each workspace feature is turned off, in the app's words
  it.each(READMES)('%s says where the workspace features are turned off, as the app names them', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    const m = CATALOGS[lang].messages
    for (const key of ['settings.workspace.layoutMemory', 'settings.workspace.problemsTab', 'settings.workspace.contextBridge', 'shortcut.unbind', 'shortcut.resetOne'] as const) {
      expect(text).toContain(`**${m[key]}**`)
    }
    expect(text).toContain(`${m['settings.title']} › ${m['settings.tab.general']}`)
    expect(text).toContain(`${m['settings.title']} › ${m['settings.tab.shortcuts']}`)
  })

  // Final review M3: the palette, go to file and find in files are one box, so one key alone does not turn it off
  const ALL_THREE: Record<Lang, string> = { en: 'all three', ko: '세 키를 모두', ja: '3 つのキーをすべて', es: 'sus tres teclas' }
  it.each(READMES)('%s and the settings hint say all three keys go to turn the box off', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(ALL_THREE[lang])
    expect(CATALOGS[lang].messages['settings.workspace.hint']).toContain(ALL_THREE[lang])
  })

  it.each(READMES)('%s names sending a selection to an agent as the app does', (file, lang) => {
    const text = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8')
    expect(text).toContain(`**${CATALOGS[lang].messages['shortcut.context.attachSelection']}:**`)
  })
})
