import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The AppImage carries an AppStream metainfo file so the AppImage catalog (appimage.github.io) shows Astera's summary,
// description and screenshot rather than the screenshot its test takes of the first-run window. The catalog reads it
// from usr/share/metainfo/ inside the AppImage, which is the root of the unpacked app that linux.extraFiles copies into.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ID = 'io.github.parsingk.astera'
const SOURCE = `build/${ID}.metainfo.xml`

// js-yaml is electron-builder's own YAML reader, installed with it
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type BuilderConfig = {
  appId: string
  executableName?: string
  linux?: { extraFiles?: Array<{ from: string; to: string }> }
}

const config = yaml.load(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')) as BuilderConfig
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { name: string; license: string }
const metainfo = (): string => readFileSync(path.join(repoRoot, SOURCE), 'utf8')
const tag = (xml: string, name: string): string | undefined => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`))?.[1]

describe('the AppImage’s AppStream metainfo', () => {
  it('is copied to usr/share/metainfo/ under the app’s id, for the Linux builds', () => {
    expect(config.linux?.extraFiles).toContainEqual({ from: SOURCE, to: `usr/share/metainfo/${ID}.metainfo.xml` })
    expect(config.appId).toBe(ID)
    expect(existsSync(path.join(repoRoot, SOURCE))).toBe(true)
  })

  it('names the app’s id, its license and the desktop file electron-builder writes', () => {
    const xml = metainfo()
    expect(xml).toContain('<component type="desktop-application">')
    expect(tag(xml, 'id')).toBe(ID)
    expect(tag(xml, 'project_license')).toBe(pkg.license)
    // electron-builder names the AppImage's desktop file after the executable, the package name unless set
    expect(tag(xml, 'launchable')).toBe(`${config.executableName ?? pkg.name}.desktop`)
  })

  it('shows a screenshot that is a file in the repository’s main branch', () => {
    const image = tag(metainfo(), 'image')
    const prefix = 'https://raw.githubusercontent.com/parsingk/Astera/main/'
    expect(image?.startsWith(prefix)).toBe(true)
    expect(existsSync(path.join(repoRoot, image!.slice(prefix.length)))).toBe(true)
  })
})
