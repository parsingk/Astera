// The sandbox's refusals (sandbox design §6, E5) and its 설정하기 speak in every language the app does, in the words the
// plan gave for them.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const GIVEN = {
  'session.spawn.sandbox.windowsSetup': [
    '이 Codex 계정은 Windows sandbox가 설정되지 않았습니다. 설정하기를 누르면 관리자 확인 창이 한 번 뜹니다.',
    "This Codex account has no Windows sandbox set up yet. Set up shows Windows' administrator prompt once.",
    'この Codex アカウントには Windows サンドボックスがまだ設定されていません。「設定する」を押すと管理者の確認が一度表示されます。',
    'Esta cuenta de Codex aún no tiene el sandbox de Windows configurado. Configurar muestra una vez el aviso de administrador de Windows.'
  ],
  'session.spawn.sandbox.setUp': ['설정하기', 'Set up', '設定する', 'Configurar'],
  'session.spawn.sandbox.setUpDone': ['설정했습니다. 다시 시작해 주세요.', 'Set up. Start it again.', '設定しました。もう一度起動してください。', 'Configurado. Iníciala de nuevo.'],
  'session.spawn.sandbox.codexDaemon': [
    '이 Codex는 --no-daemon을 지원하지 않아 sandbox로 시작할 수 없습니다. Codex를 업데이트해 주세요.',
    'This Codex does not take --no-daemon, so it cannot start in the sandbox. Update Codex.',
    'この Codex は --no-daemon に対応していないため、サンドボックスで起動できません。Codex を更新してください。',
    'Este Codex no admite --no-daemon, así que no puede iniciarse en el sandbox. Actualiza Codex.'
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
  'session.spawn.sandbox.notPrepared': [
    'sandbox 준비가 끝나기 전에 시작하려 했습니다. 다시 시작해 주세요.',
    'The session tried to start before its sandbox was prepared. Start it again.',
    'サンドボックスの準備が終わる前に起動しようとしました。もう一度起動してください。',
    'La sesión intentó iniciarse antes de preparar su sandbox. Iníciala de nuevo.'
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
  })
})
