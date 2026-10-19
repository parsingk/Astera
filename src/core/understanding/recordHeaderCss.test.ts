import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// How It Works' record header (G8 demo findings): a long request must neither squeeze the status and buttons nor push
// the write-up out of the pane. Read from styles.css as completionCss.test.ts reads its rules, here rather than under
// src/renderer, whose tsconfig has no node types.
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '../../renderer/src/styles.css'), 'utf8')

/** The declarations of the first rule whose selector list is exactly `selector`. */
const ruleOf = (selector: string): string => {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`))
  if (at < 0) throw new Error(`no rule for ${selector}`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('the record header keeps its buttons and the write-up reachable', () => {
  it('the status and buttons neither shrink nor wrap', () => {
    const rule = ruleOf('.hiw-fhead > .hiw-st, .hiw-fhead > button')
    expect(rule).toMatch(/flex-shrink:\s*0/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
  })

  // Review M1: in a narrow pane the heading went to zero width and the buttons were cut off past the pane's edge
  it('wraps the buttons below the heading in a narrow pane, the heading keeping a width of its own', () => {
    expect(ruleOf('.hiw-fhead')).toMatch(/flex-wrap:\s*wrap/)
    const heading = ruleOf('.hiw-fhead > div')
    expect(heading).toMatch(/min-width:\s*0/)
    expect(heading).toMatch(/flex:\s*\d+ 1 \d+em/)
  })

  // Review M2: a path with no break opportunity ran over the status and buttons
  it('breaks a long unbroken token inside the heading', () => {
    expect(ruleOf('.hiw-fhead > div')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  // Review M3: a request taller than the pane left the write-up below it with no way to scroll to it. Spec §5.5 keeps
  // the person's words in the pane, so it scrolls in a box of its own rather than being cut
  it('keeps a long request in a box of its own height that scrolls', () => {
    const rule = ruleOf('.hiw-req')
    expect(rule).toMatch(/max-height:\s*\d+(\.\d+)?em/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })
})
