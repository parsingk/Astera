import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useI18n } from '../../i18n/I18nProvider'
import { shellQuote } from '../../lib/shellQuote'

const platform = (): string => (typeof window === 'undefined' ? 'linux' : window.api.platform)
const commandText = (args: string[]): string => `kubectl ${args.map((a) => shellQuote(a, platform())).join(' ')}`

/** The kubectl commands a confirmation will run (or ran to compare), under their heading, with a button that copies them. */
export function KubeCommands({
  lines,
  title
}: {
  lines: string[][]
  title: 'kube.confirm.commandsToRun' | 'kube.confirm.commandsToCompare'
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  if (lines.length === 0) return null
  const copyAll = (): void => {
    window.api.clipboard.writeText(lines.map(commandText).join('\n'))
    setCopied(true)
  }
  return (
    <>
      <div className="kube-list-title">{t(title)}</div>
      <div className="kube-commands">
        <pre className="kube-cmd-text">{lines.map((l) => `$ ${commandText(l)}`).join('\n')}</pre>
        <button
          type="button"
          className="icon-btn"
          title={t('kube.confirm.copyCommands')}
          aria-label={t('kube.confirm.copyCommands')}
          onClick={copyAll}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
    </>
  )
}
