import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { verbKeyOf, groupKeyOf, summarize, outcomeText, shortenTarget, ToolRow, ToolRowGroup } from './ToolRow'
import type { ThreadGroupPart } from '../assistant-ui/elements/thread.aui'
import { ToolGroupRoot, ToolGroupContent } from '../assistant-ui/elements/tool-group.aui'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

// `ToolRowGroup` reads tool names off `useAuiState` rather than a runtime provider (see the brief
// and the report on why), so the fixture only needs `s.message.parts` — nothing else in the real
// store's shape. A `let`, not a fixed literal: fix-round-2 needs one test whose message has more
// parts than the group's own `indices` cover, to prove the group counts only its own run rather
// than every tool call in the message — a fixture that happens to have exactly as many parts as
// `indices` selects (round 1's fixture) cannot tell those two behaviors apart.
let mockParts: Array<{ type: string; toolName?: string }> = []

vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>()
  return {
    ...actual,
    useAuiState: (selector: (s: unknown) => unknown) => selector({ message: { parts: mockParts } })
  }
})

describe('verbKeyOf', () => {
  it('maps each of the six tool names to its verb key', () => {
    expect(verbKeyOf('Read')).toEqual({ key: 'conversation.verb.read' })
    expect(verbKeyOf('Grep')).toEqual({ key: 'conversation.verb.find' })
    expect(verbKeyOf('Glob')).toEqual({ key: 'conversation.verb.find' })
    expect(verbKeyOf('Edit')).toEqual({ key: 'conversation.verb.edit' })
    expect(verbKeyOf('Write')).toEqual({ key: 'conversation.verb.create' })
    expect(verbKeyOf('Bash')).toEqual({ key: 'conversation.verb.run' })
  })

  it('passes an unknown tool name through unchanged', () => {
    expect(verbKeyOf('WebFetch')).toEqual({ name: 'WebFetch' })
  })
})

describe('groupKeyOf', () => {
  // Same six names, same fallback — the running row's left column and the collapsed group's
  // trigger read off this instead of verbKeyOf, so it needs to agree with verbKeyOf on which tools
  // are known, just naming the group form instead of the verb form.
  it('maps each of the six tool names to its group key', () => {
    expect(groupKeyOf('Read')).toEqual({ key: 'conversation.group.read' })
    expect(groupKeyOf('Grep')).toEqual({ key: 'conversation.group.find' })
    expect(groupKeyOf('Glob')).toEqual({ key: 'conversation.group.find' })
    expect(groupKeyOf('Edit')).toEqual({ key: 'conversation.group.edit' })
    expect(groupKeyOf('Write')).toEqual({ key: 'conversation.group.create' })
    expect(groupKeyOf('Bash')).toEqual({ key: 'conversation.group.run' })
  })

  it('passes an unknown tool name through unchanged', () => {
    expect(groupKeyOf('WebFetch')).toEqual({ name: 'WebFetch' })
  })
})

describe('summarize', () => {
  it('counts a run by kind, in the order each kind first appeared', () => {
    expect(summarize(['Read', 'Grep', 'Edit', 'Edit', 'Bash'])).toEqual([
      { kind: 'read', count: 1 },
      { kind: 'find', count: 1 },
      { kind: 'edit', count: 2 },
      { kind: 'run', count: 1 }
    ])
  })

  it('is not alphabetical — a later-first-appearing kind still sorts after an earlier one', () => {
    // 'find' (Grep) appears before 'edit' (Write) here, so it must lead — alphabetically 'edit'
    // would come first.
    expect(summarize(['Grep', 'Write'])).toEqual([
      { kind: 'find', count: 1 },
      { kind: 'create', count: 1 }
    ])
  })

  it('is empty for an empty run', () => {
    expect(summarize([])).toEqual([])
  })

  it('keeps an unrecognized tool as its own kind, unmerged with any other unrecognized tool', () => {
    expect(summarize(['WebFetch', 'Task', 'WebFetch'])).toEqual([
      { kind: 'WebFetch', count: 2 },
      { kind: 'Task', count: 1 }
    ])
  })
})

describe('outcomeText', () => {
  const t = (key: string): string => key

  it('a failed call with a detail reads the failure word, then the detail', () => {
    expect(outcomeText(t, { ok: false, detail: '+14 -3' })).toBe('conversation.outcome.failed · +14 -3')
  })

  it('a failed call with no detail reads just the failure word — core leaves detail empty when ' +
    'toolUseResult was a plain string, and the row must not go blank there', () => {
    expect(outcomeText(t, { ok: false, detail: '' })).toBe('conversation.outcome.failed')
  })

  it('a successful call with an empty detail renders nothing — the ordinary, quiet case', () => {
    expect(outcomeText(t, { ok: true, detail: '' })).toBe('')
  })

  it('a successful call with a detail renders just the detail, unchanged', () => {
    expect(outcomeText(t, { ok: true, detail: '412 lines' })).toBe('412 lines')
  })
})

describe('ToolRowGroup', () => {
  // `ToolRowGroup` is typed as `ComponentType` (the slot's contract, which also admits class
  // components), but it is in fact the plain function component below. Calling it directly, rather
  // than mounting it, is what lets the identity test inspect the returned element tree without
  // needing the group open (see the closed-state note further down). Unwraps one `memo()` layer —
  // exactly what `tool-group.aui.tsx`'s own `ToolGroup` already does to itself — so a future
  // `memo(ToolRowGroup)` fails, if it ever does, on an assertion about the wrapper this test guards,
  // not on an unrelated "is not a function" from calling a memo descriptor as if it were the render
  // function.
  function asCallable<P>(component: unknown): (props: P) => React.ReactElement {
    const candidate =
      typeof component === 'function' ? component : (component as { type?: unknown } | null)?.type
    if (typeof candidate !== 'function') {
      throw new Error(
        'ToolRowGroup is neither a function component nor a memo()-wrapped one — this test needs a ' +
          'new way to reach its render function, not a generic "is not callable" failure.'
      )
    }
    return candidate as (props: P) => React.ReactElement
  }

  // A collapsed group's content is present-but-hidden in Radix's own closed-state contract (a
  // `Presence`-gated node with `hidden`, not omitted outright) — see CollapsibleContentImpl in
  // @radix-ui/react-collapsible. So a mounted, still-collapsed render can only prove the two slots
  // exist and that our own trigger text replaced the wrapper's default "N tool calls" — not that a
  // child sits inside; the render never opens, so `ToolGroupContent`'s own children stay unmounted
  // until then. The nesting test below proves that instead, without needing the group open.
  it('mounts through the vendored ToolGroupRoot/ToolGroupContent slots, with our own trigger text', () => {
    mockParts = [
      { type: 'tool-call', toolName: 'Read' },
      { type: 'tool-call', toolName: 'Grep' }
    ]
    const group: ThreadGroupPart = { type: 'group-tool', status: { type: 'complete' }, indices: [0, 1] }
    const html = renderToStaticMarkup(
      React.createElement(
        ToolRowGroup,
        { group },
        React.createElement('div', { 'data-testid': 'tool-row-child' }, 'a child row')
      )
    )
    expect(html).toContain('data-slot="tool-group-root"')
    expect(html).toContain('data-slot="tool-group-content"')
    // Our own summary line (mocked t() echoes the key), not the wrapper's default "N tool calls".
    expect(html).toContain('conversation.group.read 1')
    expect(html).toContain('conversation.group.find 1')
    expect(html).not.toContain('tool calls')
  })

  // Guards the fix-round-1 decision directly: this must stay the vendored `ToolGroupRoot` /
  // `ToolGroupContent` (tool-group.aui.tsx), not a bespoke Collapsible, because that wrapper is what
  // calls `useScrollLock` during the expand animation — the difference between "expanding a
  // collapsed run lands in place" and "the viewport jumps out from under the reader". Checked at
  // the element level: identity — is this the same `ToolGroupRoot` import as `tool-group.aui.tsx`'s,
  // not a lookalike — is exactly what a re-vendor or a well-meaning rewrite could quietly break
  // without touching any text this test would otherwise see.
  it('nests children in ToolGroupContent inside ToolGroupRoot — the real imports, not lookalikes', () => {
    mockParts = [
      { type: 'tool-call', toolName: 'Read' },
      { type: 'tool-call', toolName: 'Grep' }
    ]
    const group: ThreadGroupPart = { type: 'group-tool', status: { type: 'complete' }, indices: [0, 1] }
    const marker = React.createElement('div', { 'data-testid': 'tool-row-child' }, 'a child row')
    const call = asCallable<{ group: ThreadGroupPart; children: React.ReactNode }>(ToolRowGroup)
    const element = call({ group, children: marker })
    expect(element.type).toBe(ToolGroupRoot)

    const rootChildren = React.Children.toArray(
      (element.props as { children: React.ReactNode }).children
    )
    const content = rootChildren.find(
      (c): c is React.ReactElement<{ children: React.ReactNode }> =>
        React.isValidElement(c) && c.type === ToolGroupContent
    )
    expect(content).toBeDefined()
    expect(content?.props.children).toBe(marker)
  })

  // The message carries a third tool call (Edit, at index 1) that is not part of this run — only
  // indices 0 and 2 (Bash and Grep) are. A selector that counted every tool-call part in the
  // message instead of following `group.indices` would print an extra "conversation.group.edit 1"
  // here; round 1's fixture (exactly as many parts as `indices` selects) could never have caught
  // that, since both readings would have produced the same two counts.
  it('counts only its own run — the message has more tool calls than this group claims', () => {
    mockParts = [
      { type: 'tool-call', toolName: 'Bash' },
      { type: 'tool-call', toolName: 'Edit' },
      { type: 'tool-call', toolName: 'Grep' }
    ]
    const group: ThreadGroupPart = { type: 'group-tool', status: { type: 'complete' }, indices: [0, 2] }
    const html = renderToStaticMarkup(React.createElement(ToolRowGroup, { group }))
    expect(html).toContain('conversation.group.run 1')
    expect(html).toContain('conversation.group.find 1')
    expect(html).not.toContain('conversation.group.edit')
  })

  // Guards the `.filter(Boolean)` after the split. An index that points at nothing, or at a
  // part that is not a tool call, maps to an empty name, and without the filter `summarize`
  // counts that empty string as a kind of its own — the trigger then carries a bare count with
  // no label in front of it. No other fixture reaches past its parts, so none of them can tell
  // whether the filter is there.
  it('ignores an index that points at nothing, rather than counting it as a nameless kind', () => {
    mockParts = [{ type: 'tool-call', toolName: 'Read' }, { type: 'text' }]
    const group: ThreadGroupPart = {
      type: 'group-tool',
      status: { type: 'complete' },
      indices: [0, 1, 7]
    }
    const html = renderToStaticMarkup(React.createElement(ToolRowGroup, { group }))
    expect(html).toContain('conversation.group.read 1')
    // With the filter there is exactly one kind, so the ' · ' separator never appears.
    // Without it the empty name becomes a second kind and the separator shows up in front of a
    // bare, label-less count.
    expect(html).not.toContain('·')
  })
})

// The branch choosing which label shape the left column takes lives in ToolRow, not in either
// lookup function, so testing verbKeyOf and groupKeyOf in isolation leaves it uncovered. A
// refactor that merges the two branches, on the grounds that both return a ToolLabel, puts the
// finished verb back next to the running marker with every test still green.
describe('ToolRow — which label the left column takes', () => {
  const render = (toolName: string, result: { ok: boolean; detail: string } | undefined): string =>
    renderToStaticMarkup(
      React.createElement(ToolRow as React.ComponentType<Record<string, unknown>>, {
        type: 'tool-call',
        toolCallId: 't1',
        toolName,
        args: { target: 'src/a.ts' },
        result,
        status: { type: 'complete' },
        addResult: () => {},
        resume: () => {},
        respondToApproval: async () => {}
      })
    )

  it('uses the group form while the call is still running', () => {
    const html = render('Read', undefined)
    expect(html).toContain('conversation.group.read')
    expect(html).not.toContain('conversation.verb.read')
  })

  it('uses the finished form once the call has an outcome', () => {
    const html = render('Read', { ok: true, detail: '412 lines' })
    expect(html).toContain('conversation.verb.read')
    expect(html).not.toContain('conversation.group.read')
  })
})

describe('shortenTarget', () => {
  it('keeps the full path for Read', () => {
    expect(shortenTarget('Read', 'src/main/orchestration/store.ts')).toBe(
      'src/main/orchestration/store.ts'
    )
  })

  it('keeps only the basename for Edit and Write', () => {
    expect(shortenTarget('Edit', 'src/main/orchestration/store.ts')).toBe('store.ts')
    expect(shortenTarget('Write', 'src/main/orchestration/store.ts')).toBe('store.ts')
  })

  // Both targets carry a '/', unlike round 1's fixtures ('vitest run store.test.ts',
  // 'TODO.*urgent') — neither of those has any separator, so the basename branch's
  // `lastIndexOf('/')` returns -1 for them regardless of whether the Edit/Write guard is even
  // there, and removing the guard could not have turned that test red. With a real, separator-
  // bearing target (a command or pattern naming a path, which is the ordinary case for both
  // tools), a live "basename everything" bug does show up — confirmed below.
  it('passes Bash and Grep through untouched', () => {
    expect(shortenTarget('Bash', 'npx vitest run src/core/history/parser.test.ts')).toBe(
      'npx vitest run src/core/history/parser.test.ts'
    )
    expect(shortenTarget('Grep', 'src/core/**/*.test.ts')).toBe('src/core/**/*.test.ts')
  })
})
