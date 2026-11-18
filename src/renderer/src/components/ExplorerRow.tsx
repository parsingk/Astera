import { memo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { resolveFileIcon, resolveFolderIcon } from '../../../core/files/icons'
import type { GitState } from '../../../core/git/status'
import type { KubeFileKind } from '../../../core/kube/types'
import { FileIcon } from './FileIcon'
import { RowLoading } from './ExplorerLoading'
import { ROW_H } from './explorerRows'
import { useI18n } from '../i18n/I18nProvider'
import type { Entry } from '../hooks/useFileTree'

/** What a tree row does with its events. FileExplorer hands every row the same object for its whole
 *  life (the functions inside read the latest state through a ref), so passing it does not defeat the
 *  row's memo. */
export interface RowActions {
  click: (entry: Entry, ev: React.MouseEvent<HTMLDivElement>) => void
  doubleClick: (entry: Entry, ev: React.MouseEvent<HTMLDivElement>) => void
  contextMenu: (entry: Entry, ev: React.MouseEvent<HTMLDivElement>) => void
  dragStart: (entry: Entry, ev: React.DragEvent<HTMLDivElement>) => void
  dragEnd: (entry: Entry, ev: React.DragEvent<HTMLDivElement>) => void
  dragOver: (entry: Entry | null, ev: React.DragEvent<HTMLDivElement>) => void
  dragLeave: (entry: Entry, ev: React.DragEvent<HTMLDivElement>) => void
  drop: (entry: Entry | null, ev: React.DragEvent<HTMLDivElement>) => void
}

// git status → display letter and tooltip key. The letters are language-neutral, so they are not translated.
const GIT_MARK: Record<GitState, string> = {
  new: 'U',
  modified: 'M',
  deleted: 'D',
  conflict: 'C'
}
const GIT_LABEL: Record<
  GitState,
  'explorer.git.new' | 'explorer.git.modified' | 'explorer.git.deleted' | 'explorer.git.conflict'
> = {
  new: 'explorer.git.new',
  modified: 'explorer.git.modified',
  deleted: 'explorer.git.deleted',
  conflict: 'explorer.git.conflict'
}

export interface ExplorerRowProps {
  entry: Entry
  depth: number
  /** the row's top inside the tree's spacer, px */
  top: number
  /** folders only: expanded */
  open: boolean
  selected: boolean
  cut: boolean
  dragging: boolean
  /** folders only: the current drop target */
  dropInto: boolean
  /** files only: git state of the file */
  gitState: GitState | undefined
  /** folders only: number of changed files under it */
  gitCount: number
  /** files only: what the Kubernetes classifier says about this YAML file (absent until answered) */
  kubeKind?: KubeFileKind
  /** a delete or copy is working on (or into) this row, past ROW_SPINNER_DELAY_MS */
  busy: boolean
  /** folders only: a re-read of its children is out, past ROW_SPINNER_DELAY_MS */
  loading: boolean
  actions: RowActions
}

/** One file or folder row of the explorer tree. Memoised on plain props: a watcher batch that re-reads
 *  one folder hands the other folders' rows the same entry objects and the same flags, so only the
 *  rows that actually changed render again. */
export const ExplorerRow = memo(function ExplorerRow({
  entry,
  depth,
  top,
  open,
  selected,
  cut,
  dragging,
  dropInto,
  gitState,
  gitCount,
  kubeKind,
  busy,
  loading,
  actions
}: ExplorerRowProps): React.JSX.Element {
  const { t } = useI18n()
  const common = {
    style: { position: 'absolute', left: 0, right: 0, top, height: ROW_H, paddingLeft: depth * 14 + 8 } as const,
    onClick: (ev: React.MouseEvent<HTMLDivElement>) => actions.click(entry, ev),
    onContextMenu: (ev: React.MouseEvent<HTMLDivElement>) => actions.contextMenu(entry, ev),
    draggable: true,
    onDragStart: (ev: React.DragEvent<HTMLDivElement>) => actions.dragStart(entry, ev),
    onDragEnd: (ev: React.DragEvent<HTMLDivElement>) => actions.dragEnd(entry, ev),
    onDragOver: (ev: React.DragEvent<HTMLDivElement>) => actions.dragOver(entry, ev),
    onDragLeave: (ev: React.DragEvent<HTMLDivElement>) => actions.dragLeave(entry, ev),
    onDrop: (ev: React.DragEvent<HTMLDivElement>) => actions.drop(entry, ev)
  }
  if (!entry.isDir) {
    return (
      <div
        // No drop-into here — dropping on a file targets its parent, and highlighting the parent folder
        // row is what reads correctly as "where this is going". Highlighting the file row itself would
        // look like dropping inside that file.
        className={`fx-row file${selected ? ' selected' : ''}${cut ? ' cut' : ''}${dragging ? ' dragging' : ''}`}
        title={entry.path}
        // Opening is the double click's job, so that a single click leaves focus on the tree. Opening a
        // file hands the cursor to the editor (FileEditor's focused effect), and with the cursor in
        // CodeMirror the next Ctrl+C is CodeMirror's copy, which on an empty selection copies the
        // cursor's line — that is how "copy the file, paste it into the session" used to paste the
        // file's first line instead of its path.
        onDoubleClick={(ev) => actions.doubleClick(entry, ev)}
        {...common}
      >
        <span className="fx-caret" />
        <FileIcon {...resolveFileIcon(entry.name, kubeKind)} />
        <span className={`fx-name${gitState ? ` git-${gitState}` : ''}`}>{entry.name}</span>
        {/* a delete or copy working on this file, past ROW_SPINNER_DELAY_MS */}
        <RowLoading pending={busy} label="files.op.busy" />
        {gitState && (
          <span className={`fx-git-mark git-${gitState}`} title={t(GIT_LABEL[gitState])} aria-label={t(GIT_LABEL[gitState])}>
            {GIT_MARK[gitState]}
          </span>
        )}
      </div>
    )
  }
  return (
    <div
      className={`fx-row${selected ? ' selected' : ''}${cut ? ' cut' : ''}${dragging ? ' dragging' : ''}${dropInto ? ' drop-into' : ''}`}
      {...common}
    >
      <span className="fx-caret">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      <FileIcon {...resolveFolderIcon(entry.name, open)} />
      <span className="fx-name">{entry.name}</span>
      {/* A first read already shows 'Loading…' under the row — the spinner is for re-reads only */}
      {busy ? (
        // a delete or copy working on (or into) this folder, past ROW_SPINNER_DELAY_MS
        <RowLoading pending label="files.op.busy" />
      ) : (
        <RowLoading pending={loading} />
      )}
      {gitCount > 0 && (
        <span className="fx-git-count" title={t('explorer.git.folderCount', { count: gitCount })}>
          {gitCount}
        </span>
      )}
    </div>
  )
})
