import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

// The table's widths were measured in a browser (task 6 report): at 455 px the rows stack, from 595 px on they are the table
describe('Audit Logs table at the minimum window', () => {
  it('measures its own box, and stacks each row only when that box is narrow', () => {
    expect(css).toMatch(/\.security-table-wrap\s*\{[^}]*container-type:\s*inline-size/)
    const q = css.match(/@container\s*\(max-width:\s*(\d+)px\)\s*\{[^@]*?\.security-rows/)
    expect(q).not.toBeNull()
    // above the 455 px minimum content width, below the 595 px that keeps the table
    expect(Number(q?.[1])).toBeGreaterThanOrEqual(456)
    expect(Number(q?.[1])).toBeLessThan(595)
  })
})
