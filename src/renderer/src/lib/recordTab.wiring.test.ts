// G8 demo: a record's tab was titled by its whole request, so a Job made from a ticket put the quoted ticket and its
// SOURCE markers into the tab's title and tooltip. The tab is named as How It Works names the record (requestShownOf).
// Read from the source, as folderLink.wiring.test reads the App's other wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8')

describe('a record tab is named as How It Works names the record', () => {
  it('titles the tab by requestShownOf, never the raw request', () => {
    expect(app).toContain('const tab: RecordTab = { id, recordId, title: requestShownOf(record.request), projectRoot: currentProject }')
    expect(app).not.toMatch(/title: record\.request\b/)
  })
})
