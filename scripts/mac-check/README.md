# Astera macOS 점검 (mac-check)

Mac 앞에서 혼자, 한 번에 끝낼 수 있게 만든 점검 묶음입니다. 물어볼 사람이 없어도 되도록 순서대로 적었습니다.

이 폴더에 있는 것:

- `run.sh`: 자동 점검. 테스트를 돌리고, 손 점검에 쓸 작업 폴더를 만들고, 결과를 한 폴더에 모읍니다.
- `checklist.md`: 손 점검표. 개발용 Astera 앱을 띄워 놓고 하나씩 따라 합니다.
- `guide.test.mjs`: 이 안내가 저장소와 어긋나지 않았는지 보는 테스트입니다. CI 가 돌리므로 직접 돌릴 일은 없습니다.

## 무엇을, 왜 확인하나요

에이전트 프로필의 **Sandbox에서 실행** (Run in the sandbox) 을 켜면 Claude Code 와 Codex 가 각자 자기 sandbox 안에서
돕니다. 이것과 그 뒤에 고친 것들, 그리고 작은 수정 몇 가지가 macOS 에서 실제로 맞게 도는지 봅니다.

CI 의 macOS 러너에는 로그인된 Claude Code 와 Codex 가 없습니다. 그래서 진짜 CLI 가 sandbox 안에서 보통 일을 해내는지,
막아야 할 것을 막는지는 아직 아무도 Mac 에서 보지 못했습니다. 이 점검이 그 빈칸을 채웁니다.

구체적으로는 이렇습니다.

- sandbox 안의 Claude Code 와 Codex 가 보통 일을 하는지: 작업 폴더와 임시 폴더에 쓰기, `git commit`, `npm install`,
  `astera` 명령.
- 막혀야 할 것이 그냥 막히는지: 로그인 정보 폴더(`~/.ssh` 같은 것) 읽기, 키체인, 개발용 앱의 프로필 폴더에 쓰기.
  하나씩 한 번만 해 보고 실패하는지만 봅니다.
- 홈 폴더를 작업 폴더로 시작하면 경고 한 줄이 뜨는지, 그래도 프로필 폴더는 쓸 수 없는지.
- 앱 작업 공간이 앱을 닫을 때, 그 앱이 따로 떼어 띄운 자식 프로세스까지 끝내는지.
- 같은 폴더의 Codex 탭 두 개가 서로의 사용량을 가져가지 않는지 (Astera 가 `lsof` 로 대화 기록 파일의 주인을 가립니다).

## 하지 않는 것

- sandbox 를 빠져나가려는 시도는 하지 않습니다. 보통 일이 되는지, 막혀야 할 것이 그냥 막히는지만 봅니다.
- **일부러 뺀 점검이 하나 있습니다.** Claude 의 sandbox 는 `astera` 로 시작하는 명령줄을 sandbox 밖에서 돌립니다
  (`excludedCommands: ["astera *"]`). 앞에 다른 명령을 붙이거나 뒤에 이어 붙인 명령줄이 이 예외를 타고 밖에서 도는지
  보는 점검은, 위의 규칙에 따라 일부러 뺐습니다. 그래서 점검표의 `astera` 명령은 언제나 한 줄에 하나만, 아무것도
  붙이지 않고 씁니다.
- `run.sh` 는 sudo 를 쓰지 않습니다. 키체인에 손대지 않습니다. 점(.)으로 시작하는 설정 파일을 고치지 않습니다.
  Claude Code 와 Codex 를 띄우지 않습니다. 둘에게는 버전만 묻습니다(`--version`). Astera 도 sandbox 세션을 시작하기
  전에 똑같이 묻습니다.
- `scripts/measure` 의 sandbox 측정은 돌리지 않습니다. 그 측정은 가짜 로그인 정보를 홈 폴더에 쓰기 때문에 CI 러너에서만
  돌립니다.

## 준비물

- macOS. 로그인된 데스크톱 화면 앞에서 합니다. SSH 로 접속해서 하면 앱 작업 공간이 거절됩니다.
- Xcode Command Line Tools. git 과, 테스트 하나가 작은 앱을 컴파일하는 cc 가 여기서 옵니다. 없으면
  `xcode-select --install`.
- Node 22 이상. `package.json` 은 22.13.0 이상을 요구합니다. CI 는 Node 22 를 쓰고, 이 점검은 Node 24 에서도
  돌려 봤습니다.
- 이 저장소의 develop 을 받은 폴더, 그리고 그 폴더에서 한 `npm ci`.
- Claude Code 2.1.306 이상, Codex 0.160.0 이상. 둘 다 이 Mac 에서 이미 로그인되어 있어야 합니다. 터미널의 `claude`,
  `codex` 로 로그인했거나(`~/.claude`, `~/.codex`), 설치된 Astera 에서 추가한 계정이면(`~/.claude-accounts/<이름>`,
  `~/.codex-accounts/<이름>`) 됩니다.

## 걸리는 시간

- `run.sh`: 1~5분. 대부분 빌드와 테스트입니다.
- 손 점검: 30~45분.

## 무엇을 건드리나요

### run.sh

- 이 저장소 폴더 안: 빌드 결과(`out/`)와 vitest 의 캐시.
- `~/astera-mac-check-<날짜>/` 폴더 하나: 로그, 요약, 점검표 사본, 손 점검에 쓸 작업 폴더(`work/`). 테스트가 만드는 임시
  파일도 이 안의 `tmp/` 에 만들고, 끝나면 지웁니다.
- 테스트 몇 개는 창을 띄우지 않는 작은 앱(Electron 으로 된 것 하나, cc 로 컴파일한 앱 묶음 하나)을 잠깐 실행합니다.
  Dock 에 아이콘이 잠깐 보일 수 있습니다. 그런 앱이 실행되었다는 기록을 macOS 가 스스로 남길 수는 있습니다. 그것은
  `run.sh` 가 쓰는 것이 아닙니다.

### 손 점검 (개발용 앱)

- **개발용 앱은 설치된 Astera 와 다른 프로필 폴더를 씁니다:** `~/Library/Application Support/astera-dev`.
  설치된 Astera 는 `~/Library/Application Support/Astera` 를 씁니다. 코드로는 `src/main/index.ts` 가, 패키지되지 않은
  앱이면 프로필 폴더 이름 뒤에 `-dev` 를 붙입니다. 개발용 앱은 자기 Host 도 따로 띄웁니다. 그래서 설치된 Astera 의
  세션, 설정, Job 은 건드리지 않습니다. 둘을 함께 켜 두어도 됩니다.
- **계정은 새로 로그인하지 않습니다.** 이미 로그인된 `~/.claude` 와 `~/.codex` 를 **자동 감지** (Auto-detect) 로
  등록합니다. 터미널의 `claude`, `codex` 가 쓰는 바로 그 폴더이고, 세션은 그 로그인으로 돕니다. 새 로그인이 없으니
  키체인에 새 항목도 생기지 않습니다. 진짜 계정으로 짧은 세션을 몇 번 돌립니다. 로그인이 설치된 Astera 의 계정 폴더에
  있으면 자동 감지에 나오지 않으니, 그 폴더를 **가져오기** (Import) 로 등록합니다(점검표 준비 3). 이것도 새 로그인이
  아닙니다.
  - 계정 칸 위쪽의 + 버튼, **추가** (Add) 로 계정을 새로 만들지 마세요. 새 계정 폴더를 만들고 새로 로그인하게 하며,
    Claude 는 그때 키체인에 새 항목을 씁니다.
  - 개발용 앱에서 계정의 로그아웃도 하지 마세요. 진짜 로그인이 지워집니다.
  - 앱은 계정 칸에 Claude 사용량을 보여 주려고 `security` 로 Claude 로그인 항목(`Claude Code-credentials`)을 읽습니다.
    설치된 Astera 도 같은 일을 합니다. 혹시 macOS 가 키체인 접근을 묻는 창을 띄우면 거부를 누르세요. 점검에는 영향이
    없고, 사용량 숫자만 빠집니다.
- 개발용 앱에서 연 세션도 평소처럼 흔적을 남깁니다.
  - Claude Code 와 Codex 의 대화 기록: `~/.claude/projects`, `~/.codex/sessions`.
  - 작업 폴더를 믿는다는 표시: `~/.claude.json`, `~/.codex/config.toml` 에 그 폴더 항목이 생깁니다. 폴더를 처음 쓸 때
    묻는 질문에 답하거나, 앱이 워커 폴더를 미리 표시할 때입니다.
  - Astera 의 스킬 파일: `~/.claude/skills/astera-orchestration`, `~/.codex/skills/astera-orchestration`. 설치된
    Astera 도 같은 파일을 둡니다. 점검 9에서 **에이전트 앱 작업 공간** (Agent app workspace) 을 켜면 `astera-app` 스킬도
    같은 자리에 생깁니다. 설정을 다시 꺼도 지워지지 않으니, 필요 없으면 아래 '정리' 에서 지웁니다.
  - 가져온 계정이면 위의 `~/.claude`, `~/.codex` 대신 그 계정 폴더 안에 같은 것이 생깁니다.
  - 점검 4의 Job 워커가 일하는 worktree: `~/astera-worktrees/mac-check-repo/`.
  - sandbox 세션의 npm 캐시(임시 폴더의 `astera-npm-cache`)와 개발용 Host 의 소켓 폴더(임시 폴더의 `astera-host-…`).

## 순서

1. 저장소 폴더에서 develop 을 받습니다.

   ```sh
   git checkout develop
   git pull
   ```

2. 같은 폴더에서 `npm ci` 를 합니다.

3. 자동 점검을 돌립니다. Astera 의 탭 안이 아니라 보통 터미널 창에서 돌리세요.

   ```sh
   bash scripts/mac-check/run.sh
   ```

   줄마다 PASS, FAIL, SKIP, NOTE 가 붙습니다. 끝에 결과 폴더(`~/astera-mac-check-<날짜>`)를 알려 줍니다. FAIL 이 있어도
   손 점검은 그대로 하면 됩니다. 실패한 테스트의 로그 끝부분은 요약에 함께 들어갑니다.

4. 결과 폴더의 `checklist.md` 를 텍스트 편집기로 엽니다(원본 `scripts/mac-check/checklist.md` 가 아니라 사본입니다).
   맨 위에 `run.sh` 의 결과가 들어가 있습니다. 그 아래 '준비' 부터 차례로 따라 합니다. 개발용 앱은 '준비' 에서
   `npm run dev` 로 띄웁니다.

5. 점검표 맨 끝의 '마무리' 까지 합니다. 세션을 모두 닫고, 앱을 끄고, 개발용 Host 가 사라졌는지 봅니다.

6. 결과를 보냅니다(아래).

## 결과 보내기

`~/astera-mac-check-<날짜>/checklist.md` 파일 하나만 보내면 됩니다. `run.sh` 의 요약도 그 안에 들어 있습니다.

보내기 전에 한 번 훑어보세요. 비밀번호, 토큰, 키의 내용은 들어 있으면 안 됩니다. 점검의 명령은 그런 값을 출력하지
않도록 짜여 있습니다(키 파일은 크기만 봅니다).

`run.sh` 를 다시 돌리면 같은 사본의 맨 위 요약만 새로 채우고, 적어 둔 답은 그대로 둡니다. 날짜가 바뀐 뒤에 다시
돌리면 그날 날짜로 새 폴더와 새 사본이 생기고, 점검표 '준비 1' 의 `R` 도 새 폴더를 가리킵니다. 그때는 이전 사본에
적어 둔 답을 새 사본으로 옮겨 이어 채우세요.

## 다 보낸 뒤 정리 (원하면)

```sh
rm -rf ~/astera-mac-check-<날짜> ~/astera-worktrees/mac-check-repo
```

- 개발용 앱의 프로필 폴더 `~/Library/Application Support/astera-dev` 도 지워도 됩니다.
- `astera-app` 스킬을 쓰지 않는다면 `~/.claude/skills/astera-app` 과 `~/.codex/skills/astera-app` 을 지웁니다(가져온
  계정이면 그 계정 폴더의 `skills/astera-app`).
  설치된 Astera 에서 **에이전트 앱 작업 공간** (Agent app workspace) 을 켜 두었다면 그대로 두세요.
- 작업 폴더의 대화 기록과 믿음 표시는 지운 폴더를 가리킬 뿐이라 그대로 두어도 됩니다.

## 막히면

- `run.sh: 이 점검은 macOS 전용입니다`: Mac 에서 돌려야 합니다.
- node 가 FAIL: Node 22 의 최신판을 설치하고 `npm ci` 부터 다시 합니다.
- `npm ci` 가 FAIL: 저장소 폴더에서 `npm ci` 를 다시 합니다. 그래도 Electron 이 없다고 하면 `npm rebuild electron`.
- `tools` 가 FAIL: `xcode-select --install` 로 Command Line Tools 를 설치하고 `run.sh` 를 다시 돌립니다.
- claude 나 codex 가 FAIL: 업데이트한 뒤 `run.sh` 를 다시 돌립니다. 버전이 낮으면 개발용 앱이 sandbox 세션의 시작을
  거절합니다.
- 개발용 앱이 뜨지 않음: `npm run dev` 를 띄운 터미널의 마지막 몇 줄을 점검표의 '준비' 메모에 붙여 넣어 주세요.
- 점검 하나가 막혀 더 나갈 수 없으면, 본 것을 그 점검의 메모에 적고 다음 점검으로 넘어가세요.
