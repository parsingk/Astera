import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(path.join(here, 'RunToolRail.tsx'), 'utf8')
const panel = readFileSync(path.join(here, 'RunPanel.tsx'), 'utf8')
const bottom = readFileSync(path.join(here, 'BottomPanel.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

// W4 "log → context preview": the run console's rail sends its selection, or the end of its log, to an agent through
// the same preview an editor selection takes.
describe('a run log to an agent', () => {
  it('has a rail button for the selected run, off with no run', () => {
    expect(rail).toMatch(/title=\{t\('context\.run\.send'\)\}[^>]*disabled=\{none\}[^>]*onClick=\{\(\) => run && onSendToAgent\(run\.runId\)\}/)
  })

  it('lets the console read its selection and the end of its buffer, and lets go on unmount', () => {
    expect(panel).toMatch(/const unregisterConsole = registerRunConsole\(runId, \(\) => \(\{ selection: term\.getSelection\(\), tail: bufferTail\(term, CONTEXT_EXCERPT_LINES\) \}\)\)/)
    expect(panel).toMatch(/unregisterConsole\(\)/)
  })

  it('opens the preview from what the console holds, for sessions in the run\'s project', () => {
    expect(bottom).toMatch(/onSendToAgent=\{onSendRunLog\}/)
    expect(app).toMatch(/onSendRunLog=\{\(runId\) => \{/)
    const send = app.slice(app.indexOf('onSendRunLog={(runId) => {'), app.indexOf('onSendRunLog={(runId) => {') + 1400)
    expect(send).toMatch(/readRunConsole\(runId\)/)
    expect(send).toMatch(/logContext\(\{ run, selection: read\.selection, tail: read\.tail \}\)/)
    // Final review I4: a tail keeps its end; M8: a console that cannot be read says so
    expect(send).toMatch(/contextText\(made\.ref, made\.excerpt, '', \{ keepEnd: made\.fromTail \}\)/)
    expect(send).toMatch(/if \(!run \|\| !read\) \{\s*toast\.info\(t\('context\.run\.empty'\)\)/)
  })
})
