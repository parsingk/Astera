import type { Account } from '../../../core/types'
import type { AgentProfile } from '../../../core/agentProfiles/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'
import { pickableProfiles, profileAccounts, profileNameOf } from './agentProfilesText'
import { useAgentProfilesNaming } from '../lib/agentProfiles'

/** The "Agent profile" picker the new-session, new-Job and new-Task forms put above their account picker (Agent Profiles
 *  design §6): None, then every active profile that still has an account. Picking one hands the form the profile's
 *  accounts in order; None hands it nothing, so the form stays as it was. An active profile left without an account is
 *  not offered, and a line says why. */
export function AgentProfileField({
  profiles,
  accounts,
  value,
  onChange,
  hint
}: {
  profiles: AgentProfile[]
  accounts: Account[]
  /** The picked profile's id, '' for None. */
  value: string
  onChange: (profile: AgentProfile | undefined, accountIds: string[]) => void
  /** A line under the picker while a profile is picked: what it decides in this form. */
  hint?: string
}): React.JSX.Element | null {
  const { t } = useI18n()
  const { pickable, unpickable } = pickableProfiles(profiles, accounts)
  // No profile at all: the form looks exactly as it did before profiles
  if (pickable.length === 0 && unpickable.length === 0) return null
  return (
    <div className="field">
      <label>{t('agentProfiles.pick.label')}</label>
      <Select
        items={[{ value: '', label: t('agentProfiles.pick.none') }, ...pickable.map((p) => ({ value: p.id, label: p.name }))]}
        value={value}
        ariaLabel={t('agentProfiles.pick.label')}
        onChange={(id) => {
          const p = pickable.find((x) => x.id === id)
          onChange(p, p ? (profileAccounts(p, accounts) ?? []) : [])
        }}
      />
      {value !== '' && hint !== undefined && <p className="modal-hint">{hint}</p>}
      {unpickable.length > 0 && <p className="modal-hint">{t('agentProfiles.pick.unpickable', { names: unpickable.join(', ') })}</p>}
    </div>
  )
}

/** The agent profile a Job runs as, by name, on its card and in its detail (design §8): the id when this computer's list
 *  does not have it. The chip shape the card's other words in a pill use. */
export function AgentProfileChip({ id }: { id: string }): React.JSX.Element {
  const { t } = useI18n()
  const name = profileNameOf(useAgentProfilesNaming([id]), id)
  return (
    <span className="jobs-ordinal" title={t('agentProfiles.shown', { name })}>
      {name}
    </span>
  )
}
