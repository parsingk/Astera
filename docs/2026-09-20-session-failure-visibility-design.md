# 세션이 왜 안 뜨는지 말한다 — 실패 가시성

v1.3.24를 리뷰어가 자기 Windows 기계에 설치해 쓰다 **아무 세션도 띄우지 못하고 평가를 보류**했다
(ZeroCho TV, 2026-09-20, https://youtube.com/shorts/I5rLIrYQm5g). 앱은 그가 무엇을 잘못했는지도,
무엇이 죽었는지도 말해 주지 않았다. 이 문서는 그 침묵을 고친다.

## 1. 그 기계에서 실제로 벌어진 일

| 사실 | 근거 |
|---|---|
| Windows 11, 작업 폴더 `C:\Users\speak\OneDrive\문서\time-manager` | 영상 1:04·2:14 프레임 |
| Node 를 **Volta** 가 관리 | 터미널에 찍힌 `C:\Users\speak\AppData\Local\Volta\log\…` |
| CLI 가 즉사, 종료 코드 8 | `error: Could not parse project manifest at …\time-manager\package.json` + 앱의 `종료됨 (코드 8)` |
| 대화 세션은 `no active thread` | 개발자 도구 콘솔, `codexAdapter.ts:208` — 핸드셰이크 전에 죽었다는 뜻 |
| 시작 버튼이 한동안 안 눌리다 저절로 살아남 | 영상 0:59 "시작 버튼이 안 눌리거든요" → 1:13 "아 이제 갑자기 생기네" |

Astera 는 Windows 에서 CLI 를 `cmd.exe /c claude|codex …`로, 즉 **PATH 로** 띄운다
(`core/sessions/commands.ts`). 그 PATH 앞에 Volta 셤이 있고, Volta 는 **cwd 의 `package.json`** 을 읽어
도구 버전을 정한다. 그의 프로젝트에서 그 파싱이 실패해 Volta 가 죽었다 — 그래서 그가 시작한
**모든** 세션이 태어나자마자 끝났다. 터미널도 대화도, claude 도 codex 도.

**Volta 도 그의 `package.json` 도 우리가 고칠 것이 아니다.** 우리가 고칠 것은 그 뒤에 벌어진 침묵이다.

## 2. 왜 앱이 못 걸렀나 — 결함 넷

### D1. 대화 세션은 CLI 의 stderr 를 버린다 (뿌리)

`main/chat/nodeProcFactory.ts:23`:

```js
child.stderr?.resume() // not protocol; drained so the child cannot block on it
```

`ProcLike`(`core/sessions/proc.ts`)에 stderr 채널이 아예 없다 — `onLine`(stdout)과 `onExit` 뿐이다.
Volta 는 원인을 stderr 에 찍었으므로 **대화 창은 구조적으로 그것을 말할 수 없다.** 터미널은 pty 라
stderr 가 화면에 섞여 나온다 — 리뷰어가 겪은 "터미널엔 뭔가 뜨는데 대화는 아무것도 안 뜬다"가 이
비대칭이다.

실측(어댑터에 핸드셰이크 전에 죽는 프로세스를 물려 확인, 두 provider 동일):

```
events = [ {type:'exit', code:8}, {type:'error', message:"process ended"} ]
state.error = "process ended"
```

앱이 가진 유일한 설명이 문자열 `"process ended"` 다.

### D2. 종료 알림이 코드도 이유도 말하지 않는다

`ConversationPane.tsx:1257`:

```tsx
const banner = exited ? <ExitedNotice onGoTerminal={null} /> : chatBanner.kind === "error" ? …
```

- `exited` 가 **에러 배너를 가로챈다** — 쓸모없는 `"process ended"` 조차 안 보인다.
- `ExitedNotice` 는 `conversation.exited.title` = "이 세션은 종료되었습니다" 한 줄. 종료 코드 없음,
  이유 없음, 다시 시작 버튼 없음(`onGoTerminal={null}`).
- 본문은 `conversation.empty` = "아직 주고받은 것이 없습니다".

터미널은 `session.terminal.exited` = "종료됨 (코드 {code})"로 **코드라도** 준다(`TerminalView.tsx:251`).
대화는 그것도 없다. 리뷰어의 "화면에서 안 떠요"는 정확한 관찰이었다.

### D3. CLI 상태 검사가 세션과 다른 cwd 에서 돈다

`ipc.ts`의 `system.checkCli`:

```js
execFile(cli, ['--version'], { shell: true, timeout: 10_000, windowsHide: true }, …)
```

`cwd` 를 주지 않아 앱 프로세스의 cwd 에서 돈다. 거기엔 `package.json` 이 없으니 **Volta 가 읽을
manifest 가 없어 그냥 통과한다.** 앱은 "codex 정상"이라 믿고 세션만 죽인다. 리뷰어가 "감지는 바로
되네요" 했다가 "화면이 안 떠요"로 간 정확한 이유다.

### D4. 시작 버튼이 왜 비활성인지 말하지 않는다

`NewSessionDialog.tsx`의 다섯 조건 중 둘이 비동기로 늦게 풀린다:

- `resolvingRepo` — 폴더를 고를 때마다 `worktrees.isGitRepo(cwd)`. OneDrive 폴더면 느리다.
- `accountIds` — `useState([accounts[0]?.id ?? ''])`. 계정 목록이 아직 안 왔으면 `['']` 로 시작하고,
  기본 계정 preselect 는 **git 검사가 끝난 뒤에** 온다.

둘 다 스피너도 설명도 없다. "다 선택한 거 같은데 안 눌린다 → 아 이제 갑자기 생기네"가 이것이다.

## 3. 결정

| # | 결정 | 이유 |
|---|---|---|
| S1 | **실패 문구는 한두 줄** | 사람이 읽을 것은 "무엇이 죽었고 왜"다. 긴 덤프는 접어 둔다 |
| S2 | stderr 는 **꼬리만, 종료 시점에만** 싣는다 | 살아 있는 동안의 stderr 는 정상 동작 중의 경고까지 배너로 끌고 와 시끄럽다. 사람이 알아야 하는 순간은 죽는 때 하나다 |
| S3 | 상한 4000자 | `CheckResult.outputTail` 과 같은 값·같은 이유. 새 숫자를 만들지 않는다 |
| S4 | 프로토콜은 새 메시지가 아니라 **기존 `proc-exit` 에 칸 하나** | Host 와 앱은 버전이 어긋날 수 있다. optional 한 칸은 옛 Host 가 안 보내도 그냥 없는 것이고, 새 메시지 타입은 옛 앱이 모르는 것이 된다 |
| S5 | `cmd.exe /c claude` 의 PATH 해석은 **그대로 둔다** | 그의 도구가 Volta 로 설치돼 있다. 셤을 우회하는 것이 오히려 틀린 동작이다 |
| S7 | toolchain 우회는 **기본값이 아니라 즉사 시 1회 재시도** | 그 변수는 세션의 모든 자식에게 상속된다. 기본으로 켜면 사용자가 의도한 버전 핀을 조용히 무시하게 되고, 그것이 고치려던 것보다 큰 고장이다 |
| S6 | 시작 막힘 사유 판정은 **core 에 순수 함수로** | 렌더러에는 테스트가 없다(`vitest` 가 `environment: 'node'`). `orchestration/nodeMeta.ts` 와 같은 이유·같은 방식 |

## 4. 고치는 것

### F1 — 대화 세션이 CLI 의 stderr 꼬리를 잡는다

- `core/sessions/proc.ts`: `ProcLike.onExit` 의 인자에 `stderrTail?: string` 을 더한다. 별도 채널이
  아니라 종료 이벤트에 붙인다(S2).
- `main/chat/nodeProcFactory.ts`: `child.stderr?.resume()` 을 **마지막 4000자를 남기는 드레인**으로
  바꾼다. 드레인은 그대로 유지된다 — 자식이 stderr 에 막히면 안 된다는 기존 이유가 여전히 맞다.
- `core/host/protocol.ts` 의 `proc-exit` 에 `stderrTail?: string` 한 칸(S4), `main/host/procFactory.ts`
  가 그것을 읽어 `onExit` 으로 넘긴다. Host 쪽 실제 수집은 Host 구현에서 같은 링 버퍼로.
- `main/chat/adapterCore.ts`: `onExit(code)` 가 `fail('process ended')` 대신 코드와 꼬리를 실은
  실패를 만든다. `ChatState.error` 는 사람이 읽을 한 줄로 두고, 꼬리는 **별도 칸**으로 싣는다 —
  한 문자열에 합치면 화면이 그것을 다시 쪼개야 한다.

### F2 — 종료 알림이 코드와 이유를 말한다 (터미널과 동등하게)

- `ExitedNotice` 가 `exitCode`, `reason`(한 줄), `detail`(stderr 꼬리)을 받는다. 렌더는
  **"이 세션은 종료되었습니다 (코드 8)"** + 한 줄 사유, 꼬리는 접힌 블록(S1).
- `exited` 가 에러 배너를 삼키지 않게 한다 — 사유를 `ExitedNotice` 안으로 접어 넣어 한 곳에서
  말한다. 두 배너를 나란히 세우면 같은 사건을 두 번 말하게 된다.
- 다시 시작 버튼을 단다. 터미널에는 있고 대화에는 없다.

### F3 — CLI 상태 검사를 세션과 같은 cwd 에서 돌린다

- `system.checkCli` 가 `cwd?: string` 을 받아 `execFile` 에 넘긴다.
- `NewSessionDialog` 이 고른 폴더를 넘긴다. 폴더가 바뀌면 다시 검사한다.
- 실패하면 시작 전에 한두 줄로 말한다: "codex 가 이 폴더에서 실행되지 않습니다" + stderr 첫 줄.
  지금은 앱이 cwd 없이 검사해 통과시키고 세션만 죽는다.

### F4 — 시작 버튼이 왜 비활성인지 말한다

- `core/sessions/startBlocked.ts`(신규): 대화상자의 상태를 받아 막고 있는 사유 하나를 돌려주는 순수
  함수(S6). 우선순위는 사람이 고칠 수 있는 것 먼저 — 계정 → CLI → 예약 → 폴더 확인 중.
- `NewSessionDialog` 이 버튼 아래 한 줄로 그린다. `resolvingRepo` 는 "폴더를 확인하는 중"이라
  기다리면 되는 것이고, 나머지 셋은 사람이 할 일이 있는 것이다 — 문구가 그 차이를 말한다.

### F5 — 프로젝트의 manifest 가 세션을 막지 못하게 한다

**`package.json` 이 깨진 것과 에이전트 CLI 가 뜨는 것은 상관이 없어야 한다.** 그 파일은 사용자의
프로젝트 것이지 codex 를 어떻게 띄울지를 정하는 것이 아닌데, PATH 앞의 toolchain 관리자가 둘을
묶어 버린다. Volta 는 `VOLTA_BYPASS` 가 있으면 버전 해석과 프로젝트 탐지를 건너뛰고 실행 파일로
바로 통과시킨다([volta-core/src/run](https://github.com/volta-cli/volta/blob/main/crates/volta-core/src/run/mod.rs)).

**항상 켜지는 않는다.** 그 변수는 세션이 띄우는 모든 자식에게 상속되므로, 에이전트가 세션 안에서
`npm test` 를 돌릴 때 사용자가 의도한 Node 핀까지 무시하게 된다. 그것은 우리가 고치려던 것보다 큰
피해다.

**대신 즉사했을 때 한 번만 다시 띄운다.** 조건은 문자열 매칭이 아니라 행동이다 — CLI 가 프로토콜을
**한 줄도 말하지 않고** 짧은 시간 안에 죽었다면, 그 앞의 무언가가 실행 자체를 거절한 것이다. 그때
`VOLTA_BYPASS=1` 을 얹어 한 번 재시도하고, **성공하면 그 사실을 사람에게 말한다** — 우회는 사용자가
핀해 둔 것과 다른 버전을 띄웠을 수 있고, 조용히 그러면 안 된다. 재시도도 실패하면 두 시도의 stderr 를
함께 보여준다(F1·F2).

행동 신호라 Volta 에만 매이지 않는다. 다른 관리자(asdf·mise 등)의 우회 변수가 필요해지면 같은 자리에
더한다 — 지금은 증거가 있는 것 하나만 넣는다.

## 5. 고치지 않는 것

Volta 자체, 리뷰어의 `package.json`, `cmd.exe /c` 의 PATH 해석(S5). 살아 있는 동안의 stderr
스트리밍(S2) — 필요해지면 그때 프로토콜에 더한다. 그리고 **우회를 기본값으로 켜는 것**(F5) —
사용자의 의도적인 버전 핀을 조용히 무시하는 쪽이 더 나쁜 고장이다.

## 6. 테스트

| 파일 | 고정하는 것 |
|---|---|
| `nodeProcFactory.test.ts` | stderr 가 드레인되면서도 꼬리가 남는다; 4000자를 넘으면 뒤에서 자른다; stderr 가 없으면 칸이 없다 |
| `adapterCore.test.ts` | 핸드셰이크 전에 죽으면 사유가 `"process ended"` 가 아니라 코드와 꼬리를 싣는다 |
| `codexAdapter.test.ts` / `claudeAdapter.test.ts` | 두 provider 모두 같은 실패 모양을 낸다 |
| `startBlocked.test.ts` (신규) | 다섯 조건의 우선순위, 아무것도 안 막으면 null |
| `paneTransport.test.ts` | 종료와 에러가 함께 있을 때 한 배너로 접힌다 |
| `retryBypass.test.ts` (신규) | 프로토콜을 한 줄이라도 말했으면 재시도하지 않는다; 말없이 즉사하면 한 번만 재시도한다; 두 번은 없다; 재시도 성공은 사람에게 알린다 |
| `catalog.test.ts` | 네 로케일 키 동등성 (기존) |

렌더러는 `npm run typecheck` 와 `npm run build`. 수동 확인: PATH 앞에 즉시 `exit 8` 하며 stderr 를
뱉는 가짜 `codex` 를 놓고 대화 세션을 띄워, 배너가 코드와 그 문장을 말하는지 본다.
