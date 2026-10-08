// The Remote Runtime docs say what v1 promises and asks of a person (design §6 Phase 11 acceptance, v1 §31 and §32):
// each sentence below is one a person acts on, so losing it in an edit is a regression.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '../../..')
const read = (f: string): string => readFileSync(path.join(root, f), 'utf8')

describe('docs/remote-runtime.md', () => {
  const doc = read('docs/remote-runtime.md')
  const says: Array<[string, RegExp]> = [
    ['the reboot promise', /back when its user logs in/],
    ['the crash promise', /crashed Host is back at once[^.]*astera runtime serve/],
    ['the skipped-schedule rule', /schedule time that passes while the Host is down is skipped, not fired late/],
    ['the Slack sentence', /follow the Runtime machine's own Slack settings/],
    ['the Linux support sentence', /Linux[^.]*\.deb[^.]*desktop session[^.]*v1\.1/],
    ['pairing', /[Pp]air with the string the Runtime prints/],
    ['accounts', /signed in on the Runtime machine, in the Astera app, once/],
    ['MCP HTTP lan', /`lan`[^.]*not a secure (?:remote path|way)/],
    ['the MCP authority rule', /allowed only when all three agree/],
    ['stop order', /`astera runtime stop` before `astera host stop`/],
    ['the cost sentence', /Astera does not require a hosted relay or cloud service for Remote Runtime/],
    ['the Windows recipe', /### Windows[\s\S]*runtime serve/],
    ['the macOS recipe', /### macOS[\s\S]*runtime serve[\s\S]*keychain/],
    ['the Linux recipe', /### Linux[\s\S]*enable-linger[\s\S]*runtime serve/],
    ['the desktop app', /## Use it from the Astera app/],
    ['troubleshooting', /## Troubleshooting/]
  ]
  for (const [what, re] of says) it(`says ${what}`, () => expect(doc).toMatch(re))
})

describe('README', () => {
  it('the English README names Remote runtimes and needs no relay', () => {
    const readme = read('README.md')
    expect(readme).toMatch(/\*\*Remote runtimes\*\*/)
    expect(readme).toContain('No Astera relay or cloud service is required.')
  })
  for (const f of ['README.ko.md', 'README.ja.md', 'README.es.md'])
    it(`${f} has the Remote runtimes paragraph and links the guide`, () => {
      const readme = read(f)
      expect(readme).toMatch(/\*\*Remote runtime/i)
      expect(readme).toContain('docs/remote-runtime.md')
    })
})
