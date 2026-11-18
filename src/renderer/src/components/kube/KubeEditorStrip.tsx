import type { KubeFileKind, KubeStatus, KubeTargetView } from '../../../../core/kube/types'
import type { useKubeEditor } from '../../hooks/useKubeEditor'
import { displayTarget, kubePill } from '../../hooks/useKubeOps'
import { useI18n } from '../../i18n/I18nProvider'
import { ClusterPicker, NamespacePicker } from './ClusterPicker'
import { KubeToolbar } from './KubeToolbar'

/** The kind-and-name chip (spec 4.3): "Deployment · api", a resource count, or through an overlay how many resources
 *  it renders, from the latest `status` (nothing until that is known; the overlay pill names the overlay). */
export function resourceLabel(
  resource: KubeTargetView['resource'],
  count: (n: number) => string,
  status: KubeStatus | null = null
): string | null {
  if (resource === null) return null
  if ('overlay' in resource) return status?.resourceCount === undefined ? null : count(status.resourceCount)
  if ('count' in resource) return count(resource.count)
  return resource.name === null ? resource.kind : `${resource.kind} · ${resource.name}`
}

/** The toolbar of one open Kubernetes file, fed from useKubeEditor, with its pickers mounted only while open (the
 *  picker seeds its folder choice once). Nothing until the target first arrives, except a Helm notice or a missing
 *  kubectl, which need none. */
export function KubeEditorStrip({
  path,
  kind,
  projectRoot,
  editor,
  busy,
  onOpenSettings
}: {
  path: string
  kind: KubeFileKind
  projectRoot: string
  editor: ReturnType<typeof useKubeEditor>
  busy: boolean
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const entry = editor.entries[path]
  const view = entry?.view ?? null
  if (view === null && kind !== 'helm-template' && !editor.kubectlMissing) return null
  const override = editor.overrideOf(path)
  const target = view ? displayTarget(view, override) : ({ state: 'none' } as const)
  const pill = view ? kubePill(view, override, editor.contexts) : null
  const picker = editor.picker?.path === path ? editor.picker.which : null
  return (
    <KubeToolbar
      kind={kind}
      target={target}
      overlays={view?.overlays ?? []}
      overlay={view?.overlay ?? null}
      pill={pill}
      nsLocked={view?.lockedNamespace ?? null}
      nsFromFile={view?.nsFromFile ?? false}
      status={entry?.status ?? null}
      statusLoading={entry?.statusLoading ?? false}
      resourceLabel={view ? resourceLabel(view.resource, (count) => t('kube.chip.resources', { count }), entry?.status ?? null) : null}
      busy={busy}
      kubectlMissing={editor.kubectlMissing}
      reloadBlocked={view?.reloadBlocked ?? null}
      brokenKustomization={view?.brokenKustomization ?? null}
      unlisted={view?.unlisted ?? false}
      renderOpen={editor.renderOpen(path)}
      onPickContext={() => editor.openPicker(path, 'context')}
      onPickNamespace={() => editor.openPicker(path, 'namespace')}
      onPickOverlay={(dir) => void editor.pickOverlay(path, dir)}
      onCompare={() => editor.toolbarAction('compare', path)}
      onApply={() => editor.toolbarAction('apply', path)}
      onReload={() => editor.toolbarAction('reload', path)}
      onDelete={() => editor.toolbarAction('delete', path)}
      onToggleRender={() => editor.toggleRender(path)}
      onOpenSettings={onOpenSettings}
    >
      {picker === 'context' && view && editor.contexts && (
        <ClusterPicker
          contexts={editor.contexts}
          selected={target.state === 'none' ? null : target.context}
          rememberFolder={view.rememberFolder}
          rememberChoices={view.rememberChoices}
          projectRoot={projectRoot}
          onPick={(context, remember) => void editor.pickContext(path, context, remember)}
          onUseContext={(context) => void editor.setCurrentContext(context)}
          onAddKubeconfig={() => void editor.addKubeconfig()}
          onOpenSettings={() => {
            editor.closePicker()
            onOpenSettings()
          }}
          onClose={editor.closePicker}
        />
      )}
      {picker === 'namespace' && (
        <NamespacePicker
          value={pill}
          onPick={(ns) => void editor.pickNamespace(path, ns)}
          onClose={editor.closePicker}
        />
      )}
    </KubeToolbar>
  )
}
