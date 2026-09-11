import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { verbKeyOf, summarize, shortenTarget, ToolRowGroup } from './ToolRow'
import type { ThreadGroupPart } from '../assistant-ui/elements/thread.aui'
import { ToolGroupRoot, ToolGroupContent } from '../assistant-ui/elements/tool-group.aui'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

// `ToolRowGroup` reads tool names off `useAuiState` rather than a runtime provider (see the brief
// and the report on why), so the fixture only needs `s.message.parts` — nothing else in the real
// store's shape.
vi.mock('@assistant-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>()
  return {
    ...actual,
    useAuiState: (selector: (s: unknown) => unknown) =>
      selector({
        message: {
          parts: [
            { type: 'tool-call', toolName: 'Read' },
            { type: 'tool-call', toolName: 'Grep' }
          ]
        }
      })
  }
})

describe('verbKeyOf', () => {
  it('maps each of the six tool names to its verb key', () => {
    expect(verbKeyOf('Read')).toBe('conversation.verb.read')
    expect(verbKeyOf('Grep')).toBe('conversation.verb.find')
    expect(verbKeyOf('Glob')).toBe('conversation.verb.find')
    expect(verbKeyOf('Edit')).toBe('conversation.verb.edit')
    expect(verbKeyOf('Write')).toBe('conversation.verb.create')
    expect(verbKeyOf('Bash')).toBe('conversation.verb.run')
  })

  it('passes an unknown tool name through unchanged', () => {
    expect(verbKeyOf('WebFetch')).toBe('WebFetch')
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

describe('ToolRowGroup', () => {
  const group: ThreadGroupPart = { type: 'group-tool', status: { type: 'complete' }, indices: [0, 1] }

  // A collapsed group's content is present-but-hidden in Radix's own closed-state contract (a
  // `Presence`-gated node with `hidden`, not omitted outright) — see CollapsibleContentImpl in
  // @radix-ui/react-collapsible. So a mounted, still-collapsed render can only prove the two slots
  // exist and that our own trigger text replaced the wrapper's default "N tool calls" — not that a
  // child sits inside; the render never opens, so `ToolGroupContent`'s own children stay unmounted
  // until then. The next test proves the nesting itself, without needing the group open.
  it('mounts through the vendored ToolGroupRoot/ToolGroupContent slots, with our own trigger text', () => {
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
  // collapsed run lands in place" and "the viewport jumps out from under the reader". Checked at the
  // element level (calling the component as a plain function, not mounting it) rather than through a
  // rendered, opened Collapsible: identity — is this the same `ToolGroupRoot` import as
  // `tool-group.aui.tsx`'s, not a lookalike — is exactly what a re-vendor or a well-meaning rewrite
  // could quietly break without touching any text this test would otherwise see.
  it('nests children in ToolGroupContent inside ToolGroupRoot — the real imports, not lookalikes', () => {
    const marker = React.createElement('div', { 'data-testid': 'tool-row-child' }, 'a child row')
    // `ToolRowGroup` is typed as `ComponentType` (the slot's contract, matching class components
    // too), but it is in fact the plain function component below — calling it directly, instead of
    // mounting it, is what lets this test inspect the returned element tree without needing the
    // group open.
    const asFunction = ToolRowGroup as unknown as (props: {
      group: ThreadGroupPart
      children: React.ReactNode
    }) => React.ReactElement<{ children: React.ReactNode }>
    const element = asFunction({ group, children: marker })
    expect(element.type).toBe(ToolGroupRoot)

    const rootChildren = React.Children.toArray(element.props.children)
    const content = rootChildren.find(
      (c): c is React.ReactElement<{ children: React.ReactNode }> =>
        React.isValidElement(c) && c.type === ToolGroupContent
    )
    expect(content).toBeDefined()
    expect(content?.props.children).toBe(marker)
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

  it('passes Bash and Grep through untouched', () => {
    expect(shortenTarget('Bash', 'vitest run store.test.ts')).toBe('vitest run store.test.ts')
    expect(shortenTarget('Grep', 'TODO.*urgent')).toBe('TODO.*urgent')
  })
})
