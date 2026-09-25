import type { UnattendedPermission } from '../../../../core/chat/types'

/** One row of the mode menu's unattended-policy section (chat takeover P8): what this chat session
 *  does with a permission prompt nobody answers while a Host holds the process as its writer. */
export interface UnattendedRow {
  key: UnattendedPermission
  label: string
  checked: boolean
}

/** The two rows the mode menu adds under a separator, in this order: hold, then deny after 60 s. The
 *  row matching `current` is checked — the two are mutually exclusive, so never more than one is. */
export function unattendedRows(
  current: UnattendedPermission,
  t: (key: string) => string
): UnattendedRow[] {
  return [
    { key: 'hold', label: t('chat.unattended.hold'), checked: current === 'hold' },
    { key: 'deny-after-60s', label: t('chat.unattended.deny60'), checked: current === 'deny-after-60s' }
  ]
}
