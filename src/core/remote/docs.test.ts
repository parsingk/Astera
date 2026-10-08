// The Remote Runtime docs say what v1 promises and asks of a person (design §6 Phase 11 acceptance, v1 §31 and §32):
// each sentence below is one a person acts on, so losing it in an edit is a regression.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '../../..')
const read = (f: string): string => readFileSync(path.join(root, f), 'utf8')
/** One section, from its heading to the next heading of the same or a higher level (review M2: a pattern over the
 *  whole page would match words of another section). */
const section = (doc: string, heading: string): string => {
  const at = doc.indexOf(`\n${heading}\n`)
  if (at < 0) return ''
  const level = heading.match(/^#+/)![0].length
  const rest = doc.slice(at + heading.length + 2)
  const end = rest.search(new RegExp(`\\n#{1,${level}} `))
  return end < 0 ? rest : rest.slice(0, end)
}

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
    ['what full control can do', /Full control is the Runtime user's power/],
    ['that Jobs are not held to projects', /Jobs are not held to projects/],
    ['serve exit codes', /exits 0 when it is stopped[\s\S]{0,200}75 when an update begins[\s\S]{0,300}78 when this machine cannot start a Host/],
    ['the desktop app', /## Use it from the Astera app/],
    ['troubleshooting', /## Troubleshooting/],
    // Security audit fixes: what the person does differently because of them.
    ['the pairing string from stdin', /astera runtimes add --pair -/],
    ['replacing a Runtime under its id', /--replace/],
    ['what runtime status says about pairing', /burnedCodes[\s\S]{0,400}unsavedRevocations/],
    ['that agent sessions cannot open Remote', /refused inside an agent session/],
    ['what a change refused for the budget means', /`RUNTIME_OUTCOME_UNKNOWN` for a change, which ran/]
  ]
  for (const [what, re] of says) it(`says ${what}`, () => expect(doc).toMatch(re))

  const recipes: Array<[string, RegExp[]]> = [
    ['### Windows', [/runtime serve/, /update-hold/, /LASTEXITCODE -eq 78/, /Register-ScheduledTask/, /Unregister-ScheduledTask/, /S4U/]],
    ['### macOS', [/runtime serve/, /SuccessfulExit/, /keychain/, /not been measured/]],
    ['### Linux', [/runtime serve/, /Restart=on-failure/, /enable-linger/, /PATH/, /Measured on Ubuntu/]]
  ]
  for (const [heading, res] of recipes)
    it(`the ${heading.slice(4)} recipe says what it must, in its own section`, () => {
      const body = section(doc, heading)
      expect(body.length).toBeGreaterThan(0)
      for (const re of res) expect(body).toMatch(re)
    })
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
