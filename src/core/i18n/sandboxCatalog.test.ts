// The sandbox's refusals (sandbox design §6, E5) and its 설정하기 speak in every language the app does, in the words the
// plan gave for them.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS, t } from './index'

// As the brief gave them, with the Task 6 fix round's changes: the setup's sentence says Codex records the elevated
// sandbox as the account's default, the done line's English, and Spanish in usted like the screen's other strings
const GIVEN = {
  'session.spawn.sandbox.windowsSetup': [
    '이 Codex 계정은 Windows sandbox가 설정되지 않았습니다. 설정하기를 누르면 관리자 확인 창이 한 번 뜹니다. Codex가 이 계정의 기본 sandbox를 elevated로 기록합니다.',
    "This Codex account has no Windows sandbox set up yet. Set up shows Windows' administrator prompt once. Codex records the elevated sandbox as this account's default.",
    'この Codex アカウントには Windows サンドボックスがまだ設定されていません。「設定する」を押すと管理者の確認が一度表示されます。Codex はこのアカウントの既定のサンドボックスを elevated として記録します。',
    'Esta cuenta de Codex aún no tiene el sandbox de Windows configurado. Configurar muestra una vez el aviso de administrador de Windows. Codex guarda el sandbox elevado como predeterminado de esta cuenta.'
  ],
  'session.spawn.sandbox.setUp': ['설정하기', 'Set up', '設定する', 'Configurar'],
  'session.spawn.sandbox.setUpDone': [
    '설정했습니다. 다시 시작해 주세요.',
    "It's set up. Start the session again.",
    '設定しました。もう一度起動してください。',
    'Configurado. Inicie la sesión de nuevo.'
  ],
  'session.spawn.sandbox.setUpFailed': ['설정하지 못했습니다.', 'It could not be set up.', '設定できませんでした。', 'No se pudo configurar.'],
  'session.spawn.sandbox.windowsCheckFailed': [
    'Codex에게 이 계정의 Windows sandbox 상태를 묻지 못했습니다. Codex를 업데이트하거나 다시 시작해 주세요.',
    "Codex could not be asked about this account's Windows sandbox. Update Codex or start it again.",
    'このアカウントの Windows サンドボックスの状態を Codex に確認できませんでした。Codex を更新するか、もう一度起動してください。',
    'No se pudo consultar a Codex el estado del sandbox de Windows de esta cuenta. Actualice Codex o vuelva a iniciar la sesión.'
  ],
  'session.roll.sandbox.windowsSetup': [
    '{account} 계정은 Windows sandbox가 설정되지 않아 넘어가지 못했습니다. 설정 › 에이전트 프로필에서 이 계정의 설정하기를 눌러 주세요.',
    'Could not move to the {account} account: its Windows sandbox is not set up. Press Set up for it in Settings › Agent profiles.',
    '{account} アカウントは Windows サンドボックスが設定されていないため、切り替えられませんでした。設定 › エージェントプロファイルで、このアカウントの「設定する」を押してください。',
    'No se pudo pasar a la cuenta {account}: su sandbox de Windows no está configurado. Pulse Configurar para ella en Configuración › Perfiles de agente.'
  ],
  'session.spawn.sandbox.codexDaemon': [
    '이 Codex는 --no-daemon을 지원하지 않아 sandbox로 시작할 수 없습니다. Codex를 업데이트해 주세요.',
    'This Codex does not take --no-daemon, so it cannot start in the sandbox. Update Codex.',
    'この Codex は --no-daemon に対応していないため、サンドボックスで起動できません。Codex を更新してください。',
    'Este Codex no admite --no-daemon, así que no puede iniciarse en el sandbox. Actualice Codex.'
  ],
  'session.spawn.sandbox.pathUnsafe': [
    '폴더 경로에 Windows 명령줄이 다룰 수 없는 문자(" & | < > ^ %)가 있어 sandbox로 시작할 수 없습니다.',
    'The folder\'s path holds a character the Windows command line cannot carry (" & | < > ^ %), so it cannot start in the sandbox.',
    'フォルダーのパスに Windows のコマンドラインで扱えない文字（" & | < > ^ %）が含まれているため、サンドボックスで起動できません。',
    'La ruta de la carpeta tiene un carácter que la línea de comandos de Windows no admite (" & | < > ^ %), así que no puede iniciarse en el sandbox.'
  ],
  'session.spawn.sandbox.gitLayout': [
    '작업 폴더의 git 정보를 읽지 못해 sandbox로 시작할 수 없습니다.',
    "The work folder's git details could not be read, so it cannot start in the sandbox.",
    '作業フォルダーの git 情報を読めないため、サンドボックスで起動できません。',
    'No se pudo leer la información de git de la carpeta de trabajo, así que no puede iniciarse en el sandbox.'
  ],
  // Task 7 fix round 1: a Claude whose version cannot be read or that is not there, Claude's settings that could not be
  // written, and a refused Claude roll, which says the refusal's own words after it
  'session.spawn.sandbox.cliVersionUnknown': [
    '{cli} 버전을 읽지 못해 sandbox로 시작할 수 없습니다.',
    'The {cli} version could not be read, so it cannot start in the sandbox.',
    '{cli} のバージョンを読み取れないため、サンドボックスで起動できません。',
    'No se pudo leer la versión de {cli}, así que no puede iniciarse en el sandbox.'
  ],
  'session.spawn.sandbox.cliMissing': [
    '{cli}를 찾지 못해 sandbox로 시작할 수 없습니다.',
    '{cli} was not found, so it cannot start in the sandbox.',
    '{cli} が見つからないため、サンドボックスで起動できません。',
    'No se encontró {cli}, así que no puede iniciarse en el sandbox.'
  ],
  'session.spawn.sandbox.settingsWriteFailed': [
    'sandbox 설정 파일을 쓰지 못해 시작할 수 없습니다. 프로필 폴더에 쓸 수 있는지 확인해 주세요.',
    'The sandbox settings file could not be written, so it cannot start. Check that the profile folder can be written.',
    'サンドボックスの設定ファイルを書き込めないため、起動できません。プロファイルフォルダーに書き込めるか確認してください。',
    'No se pudo escribir el archivo de configuración del sandbox, así que no puede iniciarse. Compruebe que se puede escribir en la carpeta del perfil.'
  ],
  'session.roll.sandbox.refused': [
    '다음 계정으로 넘어가지 못했습니다: {reason}',
    'Could not move to the next account: {reason}',
    '次のアカウントに切り替えられませんでした: {reason}',
    'No se pudo pasar a la siguiente cuenta: {reason}'
  ],
  // Final fix pass, part 2 (A): a sandboxed session handing work outside its sandbox, named by its id
  'session.spawn.sandbox.outsideSandbox': [
    '{id}는 sandbox 밖에서 돌아갑니다. sandbox 안의 세션은 sandbox 밖으로 일을 넘길 수 없어서 아무것도 보내거나 시작하지 않았습니다.',
    '{id} runs outside the sandbox, and a sandboxed session cannot hand work outside it, so nothing was sent or started.',
    '{id} はサンドボックスの外で動いています。サンドボックス内のセッションはサンドボックスの外に作業を渡せないため、何も送信も起動もしませんでした。',
    '{id} se ejecuta fuera del sandbox, y una sesión en el sandbox no puede pasar trabajo fuera de él, así que no se envió ni se inició nada.'
  ],
  'session.spawn.sandbox.notPrepared': [
    'sandbox 준비가 끝나기 전에 시작하려 했습니다. 다시 시작해 주세요.',
    'The session tried to start before its sandbox was prepared. Start it again.',
    'サンドボックスの準備が終わる前に起動しようとしました。もう一度起動してください。',
    'La sesión intentó iniciarse antes de preparar su sandbox. Iníciela de nuevo.'
  ]
} as const

describe('the sandbox refusals', () => {
  it('says each one in every language, in the words given', () => {
    const order = ['ko', 'en', 'ja', 'es'] as const
    expect([...LANGS].sort()).toEqual([...order].sort())
    for (const [key, lines] of Object.entries(GIVEN)) {
      order.forEach((lang, i) => {
        expect((CATALOGS[lang].messages as Record<string, string | undefined>)[key], `${lang} ${key}`).toBe(lines[i])
      })
    }
  })

  // The version floor's wording follows Enforce's (session.spawn.enforce.cliTooOld), with the CLI and both versions, but
  // names the sandbox: switching Policies to Observe does not start a sandboxed profile's session
  it('says which CLI is too old, and the versions, without sending the person to Policies', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(m['session.spawn.sandbox.cliTooOld'], lang).toMatch(/\{cli\}[\s\S]*\{min\}[\s\S]*\{found\}/)
      expect(m['session.spawn.sandbox.cliTooOld'], lang).not.toMatch(/Enforce|Observe|Policies/)
    }
    // Spanish in usted, as the screen's other strings are
    expect((CATALOGS.es.messages as Record<string, string>)['session.spawn.sandbox.cliTooOld']).toContain('Actualice la CLI.')
  })

  // Task 7 fix round 1: a refused Claude roll's line carries the refusal's own sentence, worded in the same language
  it('a refused roll says the refusal in the language the line is in', () => {
    const reason = { key: 'session.spawn.sandbox.cliTooOld', params: { cli: 'Claude Code', found: '2.1.305', min: '2.1.306' } } as const
    expect(t('en', 'session.roll.sandbox.refused', { reason })).toBe(
      'Could not move to the next account: The sandbox works only on Claude Code 2.1.306 or later. This one is 2.1.305. Update the CLI.'
    )
    expect(t('ko', 'session.roll.sandbox.refused', { reason })).toBe(
      '다음 계정으로 넘어가지 못했습니다: sandbox는 Claude Code 2.1.306 이상에서만 쓸 수 있습니다. 지금은 2.1.305 입니다. CLI를 업데이트해 주세요.'
    )
  })
})
