// Agent profiles speak in every language the app does (Agent Profiles design §8). ko is the source: a key it has under
// these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.agentProfiles.', 'settings.tab.agentProfiles', 'agentProfiles.']

const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))

const SANDBOX_GIVEN = {
  'settings.agentProfiles.sandbox': ['Sandbox에서 실행', 'Run in the sandbox', 'サンドボックスで実行', 'Ejecutar en el sandbox'],
  'settings.agentProfiles.sandboxHint.codex': [
    'Codex: 작업 폴더와 임시 폴더 밖에는 쓰지 못하고, 로그인 정보가 있는 폴더와 OS 비밀 저장소를 읽지 못합니다. 네트워크는 됩니다.',
    'Codex: writes stay in the work and temp folders, and the folders holding logins and the OS secret store cannot be read. The network works.',
    'Codex: 書き込みは作業フォルダーと一時フォルダーの中だけで、ログイン情報のあるフォルダーと OS の秘密の保管場所は読めません。ネットワークは使えます。',
    'Codex: solo escribe en la carpeta de trabajo y la temporal, y no puede leer las carpetas con inicios de sesión ni el almacén de secretos del sistema. La red funciona.'
  ],
  'settings.agentProfiles.sandboxHint.claude': [
    'Claude: macOS와 Linux에서는 Codex와 같습니다. Windows: 셸은 제한 없음, 파일 도구만 로그인 정보가 있는 폴더를 읽지 못합니다.',
    'Claude: on macOS and Linux, the same as Codex. Windows: the shell is not restricted; only the file tools cannot read the folders holding logins.',
    'Claude: macOS と Linux では Codex と同じです。Windows: シェルは制限なし。ファイルツールだけがログイン情報のあるフォルダーを読めません。',
    'Claude: en macOS y Linux, igual que Codex. Windows: el shell no tiene límites; solo las herramientas de archivos no pueden leer las carpetas con inicios de sesión.'
  ],
  // Final fix pass (minor 6): spec §6's third limit, which doctor already says
  'settings.agentProfiles.sandboxHint.limits': [
    'sandbox 안에서는 gh가 PC의 로그인을 쓰지 못해 GitHub 작업은 Astera를 거칩니다. Windows에서 sandbox 안의 curl은 TLS에 실패하고, push는 Host가 합니다.',
    "Inside the sandbox gh cannot use the PC's login, so GitHub work goes through Astera. On Windows, curl inside the sandbox fails TLS, and pushes stay with the Host.",
    'サンドボックスの中では gh が PC のログインを使えないため、GitHub の作業は Astera を通ります。Windows ではサンドボックス内の curl が TLS に失敗し、push は Host が行います。',
    'Dentro del sandbox gh no puede usar el inicio de sesión del PC, así que el trabajo en GitHub pasa por Astera. En Windows, curl dentro del sandbox falla en TLS, y los push los hace el Host.'
  ],
  'settings.agentProfiles.sandboxState.ready': ['sandbox 준비됨', 'Sandbox ready', 'サンドボックス準備完了', 'Sandbox listo'],
  'settings.agentProfiles.sandboxState.not-set-up': ['sandbox 설정 안 됨', 'Sandbox not set up', 'サンドボックス未設定', 'Sandbox sin configurar'],
  'settings.agentProfiles.sandboxState.check-failed': ['상태를 묻지 못함', 'Could not check', '状態を確認できません', 'No se pudo comprobar'],
  'settings.security.sandboxCoverage.title': ['Sandbox가 막는 범위', 'What the sandbox blocks', 'サンドボックスが防ぐ範囲', 'Lo que bloquea el sandbox'],
  'settings.security.sandboxCoverage.class.write': ['쓰기', 'Writes', '書き込み', 'Escritura'],
  'settings.security.sandboxCoverage.class.sensitive': ['로그인 정보 폴더', 'Login folders', 'ログイン情報のフォルダー', 'Carpetas de inicio de sesión'],
  'settings.security.sandboxCoverage.class.stores': ['OS 비밀 저장소', 'OS secret store', 'OS の秘密の保管場所', 'Almacén de secretos del sistema'],
  'settings.security.sandboxCoverage.class.network': ['네트워크', 'Network', 'ネットワーク', 'Red'],
  'settings.security.sandboxCoverage.level.seen': ['허용', 'Allowed', '許可', 'Permitido'],
  'audit.coverageNote.runtime-measured': ['런타임으로 측정', 'measured on the runtime', 'ランタイムで測定', 'medido en el entorno de ejecución'],
  'audit.coverageNote.file-tools-only': ['파일 도구만', 'file tools only', 'ファイルツールのみ', 'solo herramientas de archivos'],
  'session.tab.sandboxed': ['Sandbox 안에서 실행 중', 'Running in the sandbox', 'サンドボックスで実行中', 'Ejecutándose en el sandbox'],
  // Task 8 fix round 1
  'session.tab.denyOnly': [
    'Sandbox 없음: 파일 도구만 로그인 정보 폴더를 읽지 못합니다 (셸은 제한 없음)',
    'No sandbox: only the file tools cannot read the login folders (the shell is not restricted)',
    'サンドボックスなし: ファイルツールだけがログイン情報のフォルダーを読めません（シェルは制限なし）',
    'Sin sandbox: solo las herramientas de archivos no pueden leer las carpetas de inicio de sesión (el shell no tiene límites)'
  ],
  'settings.security.sandboxCoverage.homeReadable': [
    '로그인 정보 폴더 밖의 홈 폴더는 sandbox 안에서도 읽을 수 있습니다. Claude 세션에서 사람이 `!` 로 직접 입력한 명령은 보통 sandbox 밖에서 실행됩니다(Claude Code의 sandbox 문서 참고). 에이전트가 낸 명령은 sandbox 안에서 실행됩니다.',
    'Outside the login folders, the home folder stays readable inside the sandbox. In a Claude session, commands the person types with `!` usually run outside the sandbox (see Claude Code\'s sandboxing docs); the agent\'s own commands run inside it.',
    'ログイン情報のフォルダー以外のホームフォルダーは、サンドボックス内でも読めます。 Claude のセッションで人が `!` を付けて直接入力したコマンドは、通常サンドボックスの外で実行されます（Claude Code のサンドボックスのドキュメントを参照）。エージェント自身のコマンドは内側で実行されます。',
    'Fuera de las carpetas de inicio de sesión, la carpeta personal sigue siendo legible dentro del sandbox. En una sesión de Claude, los comandos que la persona escribe con `!` suelen ejecutarse fuera del sandbox (véase la documentación de sandbox de Claude Code); los del propio agente se ejecutan dentro.'
  ],
  'settings.security.sandboxCoverage.windowsClaude': ['Windows: 셸은 제한 없음', 'Windows: the shell is not restricted', 'Windows: シェルは制限なし', 'Windows: el shell no tiene límites'],
  'audit.coverageNote.bus-path-only': [
    '세션 bus가 파일 경로일 때',
    'when the session bus is a file path',
    'セッションバスがファイルパスのとき',
    'cuando el bus de sesión es una ruta de archivo'
  ]
} as const

describe('the agent profiles catalog', () => {
  it('has every agent profile key in every language', () => {
    const ko = keysOf()
    expect(ko.length).toBeGreaterThan(30)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // The person's rule for what the app says: a sentence is rewritten rather than broken with a dash
  it('has no dash inside a sentence in any language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => /\s[—–-]\s/.test(m[k] ?? '')), lang).toEqual([])
    }
  })

  // Sandbox design §6, Task 8: the switch, its per-OS lines, the readiness of each Codex account on Windows, the coverage
  // table and the tab marker, in the words the plan and the controller gave (ko, en, ja, es)
  it('says the sandbox switch, its lines, the readiness, the coverage table and the tab marker in the words given', () => {
    const order = ['ko', 'en', 'ja', 'es'] as const
    expect([...LANGS].sort()).toEqual([...order].sort())
    for (const [key, lines] of Object.entries(SANDBOX_GIVEN)) {
      order.forEach((lang, i) => {
        expect((CATALOGS[lang].messages as Record<string, string | undefined>)[key], `${lang} ${key}`).toBe(lines[i])
      })
    }
  })

  // Lifecycle design §5: Archive's reason field, the archived row's date, and a schedule that waits on an archived
  // profile, in the words the plan gave (ko, en), ja and es after the en meaning
  it('says the archive reason, the date archived and a waiting schedule in the words given', () => {
    const given = {
      'settings.agentProfiles.archiveReason': ['이유 (선택)', 'Reason (optional)', '理由（任意）', 'Motivo (opcional)'],
      'settings.agentProfiles.archivedOn': ['{date}에 보관함', 'Archived {date}', '{date} にアーカイブ', 'Archivado el {date}'],
      // Fix round 1: the reason inside an archived profile's row, said as one
      'settings.agentProfiles.archivedReason': ['이유: {reason}', 'Reason: {reason}', '理由: {reason}', 'Motivo: {reason}'],
      'jobs.run.waitingArchived': [
        '대기 중: 보관된 에이전트 프로필 {names}',
        'Waiting: agent profile {names} is archived',
        '待機中: エージェントプロファイル {names} はアーカイブ済みです',
        'En espera: el perfil de agente {names} está archivado'
      ]
    }
    const order = ['ko', 'en', 'ja', 'es'] as const
    for (const [key, lines] of Object.entries(given))
      order.forEach((lang, i) => expect((CATALOGS[lang].messages as Record<string, string | undefined>)[key], `${lang} ${key}`).toBe(lines[i]))
  })

  it('names the tab as the person chose, and keeps the Agents tab’s own name', () => {
    const names = { ko: '에이전트 프로필', en: 'Agent profiles', es: 'Perfiles de agente', ja: 'エージェントプロファイル' }
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(m['settings.tab.agentProfiles'], lang).toBe(names[lang])
    }
    expect(CATALOGS.ko.messages['settings.tab.agent']).toBe('에이전트')
  })
})
