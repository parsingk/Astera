import { useI18n } from '../i18n/I18nProvider'

/** Unpushed commits on a worktree row, doubling as the entry point to the create-PR dialog.
 *  Visible at rest rather than on hover: an affordance nobody can see is one nobody uses, and
 *  putting the state on the row is the whole point. Hover turns the fact into a button. */
export function PushBadge({
  ahead,
  base,
  onCreate
}: {
  /** null means the count is unknown (an unresolvable base, or git older than 2.41). */
  ahead: number | null
  base: string
  onCreate: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const title =
    ahead === null
      ? t('worktree.push.aheadUnknown')
      : t('worktree.push.createPrHint', { count: ahead, base })
  return (
    <button
      className="push-badge"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onCreate(e)
      }}
    >
      ↑{ahead === null ? '' : ahead}
    </button>
  )
}
