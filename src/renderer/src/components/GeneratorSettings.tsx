import { useCallback, useEffect, useState } from 'react'
import type { Account } from '../../../core/types'
import type { ModelDescriptor } from '../../../core/models/types'
import type { GeneratorSettings as GeneratorSettingsValue } from '../../../core/understanding/generatorSettings'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { Select } from './Select'

/** 설명을 누가·무엇으로 만드는가 (설계 D2·D4).
 *
 *  **셋을 한 번에 저장한다.** 계정을 바꾸면 그 계정에 없는 모델이, 모델을 바꾸면 그 모델이 받지
 *  않는 강도가 남아서는 안 된다 — 그래서 저장소도 setter 가 하나뿐이고(appSettingsStore
 *  .setGenerator), 여기서도 값을 통째로 만들어 넘긴다.
 *
 *  **모델 목록을 못 받는 것은 정상 경로다.** claude 가 로그아웃 상태일 수도, codex 의
 *  app-server(experimental)가 프로토콜을 바꿨을 수도 있다. 그때 드롭다운 대신 자유 입력칸을
 *  보여 주고 사유를 함께 적는다 — 목록이 없다고 기능까지 못 쓰게 만들 이유가 없다. */
export function GeneratorSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState<GeneratorSettingsValue>({})
  const [accounts, setAccounts] = useState<Account[]>([])
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void window.api.settings.getGenerator().then(setValue)
    void window.api.accounts.list().then(setAccounts)
  }, [])

  const loadModels = useCallback(async (accountId: string, refresh: boolean): Promise<void> => {
    setLoading(true)
    setListError(null)
    try {
      const r = await window.api.settings.listModels(accountId, refresh)
      setModels(r.models)
      setListError(r.error ?? null)
    } catch (err) {
      // IPC 자체가 실패한 경우 — 어댑터는 던지지 않으므로 여기 오는 것은 배선 문제다
      setModels([])
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // 계정이 정해지면 그 계정의 목록을 묻는다. main 이 앱 실행 단위로 캐시하므로 설정을 여닫아도
  // 왕복은 계정마다 한 번뿐이다
  useEffect(() => {
    if (!value.accountId) {
      setModels([])
      setListError(null)
      return
    }
    void loadModels(value.accountId, false)
  }, [value.accountId, loadModels])

  const save = (next: GeneratorSettingsValue): void => {
    const prev = value
    setValue(next) // 낙관적 — 실패하면 되돌린다
    void window.api.settings.setGenerator(next).catch((err) => {
      setValue(prev)
      toast.error(
        t('settings.gen.saveFailed', { detail: err instanceof Error ? err.message : String(err) })
      )
    })
  }

  // 계정을 바꾸면 모델과 강도를 함께 버린다 — 그 계정에 없는 이름이 남으면 생성이 조용히 실패한다
  const pickAccount = (accountId: string): void => save(accountId === '' ? {} : { accountId })

  // 모델을 바꾸면 강도를 버린다 — 모델마다 받는 강도가 다르다(실측: gpt-5.5 는 ultra 가 없다)
  const pickModel = (model: string): void =>
    save({ accountId: value.accountId, model: model === '' ? undefined : model })

  const pickEffort = (effort: string): void =>
    save({ accountId: value.accountId, model: value.model, effort: effort === '' ? undefined : effort })

  const chosen = models.find((m) => m.id === value.model)

  return (
    <div className="settings-gen">
      <div className="settings-row">
        <span>{t('settings.gen.label')}</span>
        <Select
          className="settings-gen-select"
          ariaLabel={t('settings.gen.label')}
          value={value.accountId ?? ''}
          placeholder={t('settings.gen.none')}
          onChange={pickAccount}
          items={[
            { value: '', label: t('settings.gen.none') },
            ...accounts.map((a) => ({ value: a.id, label: a.label, meta: a.provider ?? 'claude' }))
          ]}
        />
      </div>
      <span className="settings-hint">{t('settings.gen.hint')}</span>

      {value.accountId ? (
        <>
          <div className="settings-row">
            <span>{t('settings.gen.model')}</span>
            {listError === null && models.length > 0 ? (
              <Select
                className="settings-gen-select"
                ariaLabel={t('settings.gen.model')}
                value={value.model ?? ''}
                placeholder={t('settings.gen.modelDefault')}
                onChange={pickModel}
                items={[
                  { value: '', label: t('settings.gen.modelDefault') },
                  ...models.map((m) => ({
                    value: m.id,
                    label: m.name,
                    meta: m.isDefault ? t('settings.gen.modelDefault') : undefined
                  }))
                ]}
              />
            ) : (
              // 목록이 없어도 고를 수 있어야 한다 — 이름을 아는 사용자를 막지 않는다
              <input
                type="text"
                className="settings-gen-input"
                aria-label={t('settings.gen.model')}
                placeholder={t('settings.gen.modelPlaceholder')}
                defaultValue={value.model ?? ''}
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (next !== (value.model ?? '')) pickModel(next)
                }}
              />
            )}
          </div>

          {loading ? <span className="settings-hint">{t('settings.gen.loading')}</span> : null}
          {listError !== null && !loading ? (
            <span className="settings-hint">{t('settings.gen.listFailed', { detail: listError })}</span>
          ) : null}

          {/* 강도는 그 모델이 받을 때만 뜻이 있다 — 안 받는 모델에 칸을 보여 주면 고르고도 안 먹는다 */}
          {chosen?.effortLevels && chosen.effortLevels.length > 0 ? (
            <div className="settings-row">
              <span>{t('settings.gen.effort')}</span>
              <Select
                className="settings-gen-select"
                ariaLabel={t('settings.gen.effort')}
                value={value.effort ?? ''}
                placeholder={t('settings.gen.effortDefault')}
                onChange={pickEffort}
                items={[
                  { value: '', label: t('settings.gen.effortDefault') },
                  ...chosen.effortLevels.map((e) => ({
                    value: e,
                    label: e,
                    meta: e === chosen.defaultEffort ? t('settings.gen.effortDefault') : undefined
                  }))
                ]}
              />
            </div>
          ) : null}

          <button
            type="button"
            className="settings-gen-refresh"
            disabled={loading}
            onClick={() => void loadModels(value.accountId as string, true)}
          >
            {t('settings.gen.refresh')}
          </button>
        </>
      ) : null}
    </div>
  )
}
