import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// PaneGrid needs a DOM; the held-tab wiring is pinned by its text. Which tabs are held is decided where the layout is
// restored (App.tsx, lib/restoreLayout.ts).
const here = path.dirname(fileURLToPath(import.meta.url))
const grid = readFileSync(path.join(here, 'PaneGrid.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')
const catalog = (lang: string): string => readFileSync(path.join(here, `../../../core/i18n/messages/${lang}.ts`), 'utf8')

describe('held preview and cluster tabs (spec W3)', () => {
  it('draws a held preview as a placeholder, with no page behind it', () => {
    expect(grid).toMatch(/\{held\.has\(b\.id\) \? <HeldTab name=\{b\.url\} onLoad=\{\(\) => onRelease\(b\.id\)\} \/> : renderBrowser\(b\.id\)\}/)
  })

  it('draws a held cluster object as a placeholder, with no read behind it', () => {
    expect(grid).toMatch(/held\.has\(tabId\) \? \(\s*<HeldTab name=\{`\$\{target\.kind\} \$\{target\.name\}`\} onLoad=\{\(\) => onRelease\(tabId\)\} \/>\s*\) : \(\s*<KubeObjectTab /)
  })

  it('says why and offers to load it', () => {
    expect(grid).toMatch(/t\('layout\.held\.title'\)/)
    // Screen check: the kube toolbar's 26px icon button wrapped the word over two lines; the app's own button shape
    expect(grid).toMatch(/<button type="button" className="primary" onClick=\{onLoad\}>\s*\{t\('layout\.held\.load'\)\}/)
    for (const lang of ['ko', 'en', 'ja', 'es']) {
      expect(catalog(lang)).toMatch(/'layout\.held\.title':/)
      expect(catalog(lang)).toMatch(/'layout\.held\.load':/)
    }
  })

  it('lets go of a tab a person selects, or loads', () => {
    expect(app).toMatch(/const selectWorkbenchTab = \(tabId: string\): void => \{\s*releaseTab\(tabId\)/)
    expect(app).toMatch(/held=\{heldTabs\}\s*onRelease=\{releaseTab\}/)
  })
})
