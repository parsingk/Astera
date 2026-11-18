import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeFileKind } from '../../../core/kube/types'
import { ExplorerRow, type ExplorerRowProps, type RowActions } from './ExplorerRow'
import { kubeCandidates } from '../hooks/useKubeKinds'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const noop = (): void => {}
const actions: RowActions = {
  click: noop,
  doubleClick: noop,
  contextMenu: noop,
  dragStart: noop,
  dragEnd: noop,
  dragOver: noop,
  dragLeave: noop,
  drop: noop
}

const render = (name: string, kubeKind?: KubeFileKind, kubeFailed?: boolean): string => {
  const props: ExplorerRowProps = {
    entry: { name, path: `/p/${name}`, isDir: false } as ExplorerRowProps['entry'],
    depth: 0,
    top: 0,
    open: false,
    selected: false,
    cut: false,
    dragging: false,
    dropInto: false,
    gitState: undefined,
    gitCount: 0,
    busy: false,
    loading: false,
    actions,
    kubeKind,
    kubeFailed
  }
  return renderToStaticMarkup(React.createElement(ExplorerRow, props))
}

describe('ExplorerRow Kubernetes icon', () => {
  it('a manifest row draws the blue icon', () => {
    expect(render('deploy.yaml', 'manifest')).toContain('fi--blue')
  })

  it('plain YAML keeps the purple gear', () => {
    const html = render('values.yaml', 'plain')
    expect(html).toContain('fi--purple')
    expect(html).not.toContain('fi--blue')
  })

  it('a row with no kind yet keeps the purple gear', () => {
    expect(render('deploy.yaml')).toContain('fi--purple')
  })
})

describe('ExplorerRow failure mark', () => {
  it('a file whose last Kubernetes operation failed carries the warning glyph with its tooltip', () => {
    const html = render('deploy.yaml', 'manifest', true)
    expect(html).toContain('class="fx-kube-failed"')
    expect(html).toContain('title="kube.explorer.failed"')
  })

  it('no mark otherwise', () => {
    expect(render('deploy.yaml', 'manifest')).not.toContain('fx-kube-failed')
  })
})

describe('kubeCandidates', () => {
  it('keeps only YAML and Kustomization basenames, in either slash style, case-insensitively', () => {
    expect(
      kubeCandidates(['/p/a.yaml', 'C:\\p\\b.YML', '/p/Kustomization', '/p/readme.md', '/p/x.json', '/p/yaml'])
    ).toEqual(['/p/a.yaml', 'C:\\p\\b.YML', '/p/Kustomization'])
  })
})
