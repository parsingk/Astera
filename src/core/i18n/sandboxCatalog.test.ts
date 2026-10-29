// The sandbox's refusals (sandbox design §6, E5) and its 설정하기 speak in every language the app does, in the words the
// plan gave for them.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS, t } from './index'

// As the brief gave them, with the Task 6 fix round's changes: the setup's sentence says Codex records the elevated
// sandbox as the account's default (and, since Task P, that Astera takes that line back out), the done line's English, and Spanish in usted like the screen's other strings
const GIVEN = {
  'session.spawn.sandbox.windowsSetup': [
    '이 Codex 계정은 Windows sandbox가 설정되지 않았습니다. 설정하기를 누르면 관리자 확인 창이 한 번 뜹니다. Codex가 이 계정의 기본 sandbox를 elevated로 기록하지만 Astera가 그 줄을 다시 지우므로, sandbox 세션만 이것을 씁니다.',
    "This Codex account has no Windows sandbox set up yet. Set up shows Windows' administrator prompt once. Codex records the elevated sandbox as this account's default, and Astera takes that line back out, so only sandboxed sessions use it.",
    'この Codex アカウントには Windows サンドボックスがまだ設定されていません。「設定する」を押すと管理者の確認が一度表示されます。Codex はこのアカウントの既定のサンドボックスを elevated として記録しますが、Astera がその行を削除するため、これを使うのはサンドボックスのセッションだけです。',
    'Esta cuenta de Codex aún no tiene el sandbox de Windows configurado. Configurar muestra una vez el aviso de administrador de Windows. Codex guarda el sandbox elevado como predeterminado de esta cuenta y Astera quita esa línea, así que solo lo usan las sesiones en el sandbox.'
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
  // Task E fix round 3 (re-review Minor 6): a path the sandbox names besides the work folder, which the log names
  'session.spawn.sandbox.namedPathUnsafe': [
    '작업 폴더 말고 sandbox가 지정해야 하는 폴더(Astera 자체 폴더나 홈의 로그인 정보 폴더)의 경로에 Windows 명령줄이 다룰 수 없는 문자(" & | < > ^ %)가 있어 sandbox로 시작할 수 없습니다. 어느 폴더인지는 Astera 로그에 있습니다.',
    "A folder the sandbox has to name besides the work folder (one of Astera's own, or a login folder in your home) holds a character the Windows command line cannot carry (\" & | < > ^ %), so it cannot start in the sandbox. Astera's log names the folder.",
    '作業フォルダー以外にサンドボックスが指定するフォルダー（Astera 自身のフォルダー、またはホームのログイン情報のフォルダー）のパスに Windows のコマンドラインで扱えない文字（" & | < > ^ %）が含まれているため、サンドボックスで起動できません。どのフォルダーかは Astera のログに記録されています。',
    'Una carpeta que el sandbox debe indicar además de la carpeta de trabajo (una de Astera o una carpeta de inicio de sesión de su carpeta personal) tiene un carácter que la línea de comandos de Windows no admite (" & | < > ^ %), así que no puede iniciarse en el sandbox. El registro de Astera indica cuál es.'
  ],
  // Task E fix round 5 (rule E5): a named path through a link inside the work folder, where nothing else refuses it
  'session.spawn.sandbox.linkedPath': [
    '로그인 정보나 Astera 자체 파일이 든 폴더가 작업 폴더 안의 링크를 거쳐 있고 세션이 그 링크를 바꿀 수 있어서, sandbox가 그 폴더를 지킬 수 없어 sandbox로 시작할 수 없습니다. 프로젝트 폴더에서 시작해 주세요. 어느 링크인지는 Astera 로그에 있습니다.',
    "A folder that holds logins or Astera's own files is reached through a link inside the work folder, which the session could change, so the sandbox cannot keep it protected and the session cannot start in the sandbox. Start it in a project folder. Astera's log names the link.",
    'ログイン情報や Astera 自身のファイルを含むフォルダーが作業フォルダー内のリンクの先にあり、セッションがそのリンクを変えられるため、サンドボックスがそのフォルダーを守れず、サンドボックスで起動できません。プロジェクトのフォルダーで起動してください。どのリンクかは Astera のログに記録されています。',
    'Una carpeta con datos de inicio de sesión o con archivos propios de Astera se alcanza a través de un enlace dentro de la carpeta de trabajo, que la sesión podría cambiar, así que el sandbox no puede protegerla y la sesión no puede iniciarse en el sandbox. Iníciela en una carpeta de proyecto. El registro de Astera indica cuál es el enlace.'
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

// Task E fix rounds 2 and 3, in the order ko, en, ja, es: the session starts as today and its tab says this. Round 3:
// the Ubuntu line says what Ubuntu's profile does and points to srt's README for the fix, in its words. Round 4:
// only the AppArmor route (our run 40761549024 had the sysctl set and srt still failed under the bwrap profile)
const WARNINGS = {
  'session.sandbox.warn.homeInWorkFolder': [
    '이 sandbox 세션의 작업 폴더가 홈 폴더를 포함하고 있어서, sandbox 안에서 홈 폴더의 프로그램과 설정을 바꿀 수 있습니다. 이것들을 지키려면 프로젝트 폴더에서 시작해 주세요.',
    "This sandboxed session's work folder contains your home folder, so programs and settings in your home folder can be changed from inside the sandbox. Start it in a project folder to keep them out of reach.",
    'このサンドボックスのセッションの作業フォルダーはホームフォルダーを含んでいるため、サンドボックスの中からホームフォルダーのプログラムや設定を変更できます。それらを守るには、プロジェクトのフォルダーで起動してください。',
    'La carpeta de trabajo de esta sesión del sandbox contiene su carpeta personal, así que los programas y la configuración de su carpeta personal se pueden cambiar desde dentro del sandbox. Iníciela en una carpeta de proyecto para mantenerlos fuera de su alcance.'
  ],
  'session.sandbox.warn.claudeUserns': [
    '이 시스템에서는 Claude Code의 sandbox가 셸 명령을 실행할 수 없습니다. Ubuntu의 bubblewrap용 AppArmor 프로필(bwrap-userns-restrict)이 bubblewrap 안에서 도는 프로그램의 권한을 빼앗아, 이 세션의 셸 명령은 모두 실패합니다. 파일 도구는 그대로 쓸 수 있습니다. 해결하려면 관련 바이너리에 userns를 허용하는 AppArmor 프로필을 추가해야 합니다. 자세한 내용은 Claude Code의 sandbox 런타임(@anthropic-ai/sandbox-runtime) README의 Ubuntu 안내를 보세요.',
    "Claude Code's sandbox cannot run shell commands on this system: Ubuntu's AppArmor profile for bubblewrap (bwrap-userns-restrict) takes capabilities away from the programs running inside bubblewrap, so every shell command in this session will fail. File tools still work. The fix is an AppArmor profile that grants userns to the relevant binaries; see the Ubuntu note in the README of Claude Code's sandbox runtime (@anthropic-ai/sandbox-runtime) for the details.",
    'このシステムでは Claude Code のサンドボックスがシェルコマンドを実行できません。Ubuntu の bubblewrap 用 AppArmor プロファイル(bwrap-userns-restrict)が bubblewrap の中で動くプログラムから権限を外すため、このセッションのシェルコマンドはすべて失敗します。ファイルツールはそのまま使えます。解決するには、関連するバイナリに userns を許可する AppArmor プロファイルを追加します。詳しくは Claude Code のサンドボックスランタイム(@anthropic-ai/sandbox-runtime)の README の Ubuntu の項を参照してください。',
    'En este sistema, el sandbox de Claude Code no puede ejecutar comandos de shell: el perfil de AppArmor de Ubuntu para bubblewrap (bwrap-userns-restrict) quita los permisos a los programas que se ejecutan dentro de bubblewrap, así que todos los comandos de shell de esta sesión fallarán. Las herramientas de archivos siguen funcionando. La solución es un perfil de AppArmor que conceda userns a los binarios correspondientes; consulte los detalles en la nota sobre Ubuntu del README del entorno de sandbox de Claude Code (@anthropic-ai/sandbox-runtime).'
  ],
  // Fix round 5: a Codex session on Linux whose named path goes through a link inside the work folder
  'session.sandbox.warn.linkInWorkFolder': [
    '이 세션에서 Codex는 모든 명령을 거부합니다. 로그인 정보나 Astera 자체 파일이 든 폴더가 작업 폴더 안의 링크를 거쳐 있어, 세션이 그 링크를 바꿀 수 있기 때문입니다. 프로젝트 폴더에서 시작하면 이 문제가 없습니다.',
    "Codex will refuse every command in this session: a folder that holds logins or Astera's own files is reached through a link inside the work folder, which the session could change. Starting it in a project folder avoids this.",
    'このセッションでは Codex がすべてのコマンドを拒否します。ログイン情報や Astera 自身のファイルを含むフォルダーが作業フォルダー内のリンクの先にあり、セッションがそのリンクを変えられるためです。プロジェクトのフォルダーで起動すれば避けられます。',
    'Codex rechazará todos los comandos de esta sesión: una carpeta con datos de inicio de sesión o con archivos propios de Astera se alcanza a través de un enlace dentro de la carpeta de trabajo, que la sesión podría cambiar. Iniciarla en una carpeta de proyecto lo evita.'
  ]
} as const
/** The Linux Claude row's caption in What the sandbox blocks (coverage.ts sandboxRowCaption). */
const CAPTION = [
  'Ubuntu 25.04 이상: AppArmor의 bubblewrap 프로필 때문에 셸 명령이 실패합니다',
  "Ubuntu 25.04 and later: shell commands fail under AppArmor's bubblewrap profile",
  'Ubuntu 25.04 以降: AppArmor の bubblewrap 用プロファイルによりシェルコマンドが失敗します',
  'Ubuntu 25.04 y posteriores: los comandos de shell fallan por el perfil de AppArmor para bubblewrap'
] as const

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

  // Task E fix round 2: the two start warnings, in every language, in the words given; the pair is both sentences,
  // with no space between them in Japanese (fix round 3, re-review Minor 4)
  it('says the start warnings in every language, in the words given', () => {
    const order = ['ko', 'en', 'ja', 'es'] as const
    for (const [key, lines] of Object.entries(WARNINGS)) {
      order.forEach((lang, i) => {
        expect((CATALOGS[lang].messages as Record<string, string | undefined>)[key], `${lang} ${key}`).toBe(lines[i])
      })
    }
    order.forEach((lang, i) => {
      const m = CATALOGS[lang].messages as Record<string, string | undefined>
      // No sysctl is offered any more, in either message (fix round 4)
      for (const key of ['session.sandbox.warn.claudeUserns', 'session.sandbox.warn.claudeUsernsAndHome']) expect(m[key], `${lang} ${key}`).not.toMatch(/sysctl/)
      expect(m['session.sandbox.warn.claudeUsernsAndHome'], lang).toBe(`${WARNINGS['session.sandbox.warn.claudeUserns'][i]}${lang === 'ja' ? '' : ' '}${WARNINGS['session.sandbox.warn.homeInWorkFolder'][i]}`)
      // Fix round 5: the link warning and the home warning, the same way
      expect(m['session.sandbox.warn.linkAndHome'], lang).toBe(`${WARNINGS['session.sandbox.warn.linkInWorkFolder'][i]}${lang === 'ja' ? '' : ' '}${WARNINGS['session.sandbox.warn.homeInWorkFolder'][i]}`)
      expect(m['settings.security.sandboxCoverage.linuxClaudeUbuntu'], lang).toBe(CAPTION[i])
    })
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
