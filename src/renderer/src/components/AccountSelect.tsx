import type { Account } from '../../../core/types'
import { ProviderBadge } from './ProviderBadge'
import { Select, type SelectOption } from './Select'

/** Account picker. A thin wrapper over Select that supplies the provider badge as each row's icon.
 *
 *  The props are unchanged from when this held the dropdown itself, so none of its six call sites needed
 *  touching — account selection runs through session spawning, resume and rolling, and a signature change
 *  there is the kind of churn that hides a regression.
 *
 *  noCheck: the Claude/Codex badge already identifies the row, so a trailing check would put two marks in
 *  competition. Selection shows in the label colour, as it did before. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  allLabel,
  suffixOf,
  className
}: {
  accounts: Account[]
  value: string
  onChange: (id: string) => void
  /** When given, puts an 'All accounts' item with the value '' at the very front (the history account filter) */
  allLabel?: string
  /** Secondary text after the label (e.g. resume's ' (original account)') */
  suffixOf?: (a: Account) => string | null
  className?: string
}): React.JSX.Element {
  const items: SelectOption[] = [
    // No icon on this row, which is why Select reserves the icon column across the whole list
    ...(allLabel === undefined ? [] : [{ value: '', label: allLabel }]),
    ...accounts.map((a) => ({
      value: a.id,
      label: a.label + (suffixOf?.(a) ?? ''),
      icon: <ProviderBadge provider={a.provider} />
    }))
  ]
  return <Select items={items} value={value} onChange={onChange} className={className} noCheck />
}
