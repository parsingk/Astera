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
| S6 | 시작 막힘 사유 판정은 **core 에 순수 함수로** | 렌더러에는 테스트가 없다(`vitest` 가 `environment: 'node'`). `orchestration/nodeMeta.ts` 와 같은 이유·같은 방식 |
| S7 | toolchain 우회는 **앱이 하지 않는다 — 사람이 고른다** | 그 변수는 세션의 모든 자식에게 상속되므로, 자동이든 '한 번만' 이든 우회하는 순간 그 세션이 돌리는 모든 명령이 사용자가 핀해 둔 버전을 벗어난다. 남의 설정을 대신 뒤집는 판단이라 사람 몫이다. 앱이 할 일은 왜 막혔는지 말하고, 무엇을 포기하는지 말하고, 버튼을 주는 것까지다 |

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
- 다시 시작 **자리는 만들지만 연결하지는 않는다** — `onRestart` 슬롯을 받되 `ConversationPane.tsx`
  는 `null` 을 넘긴다. 세션을 다시 시작하는 것은 이 컴포넌트가 부를 수 있는 클릭 핸들러가 아니라
  새 spawn 이 도는 별개의 경로이고, 눌러도 아무 일도 안 나는 버튼은 버튼이 없는 것보다 나쁘다.
  `conversation.exited.restart` 키는 그래도 네 카탈로그에 그대로 둔다 — 그 버튼이 실제로 연결되는
  순간(다음 조각의 첫 항목) 바로 쓰이기 때문이다.

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

### F5 — 막힌 이유를 설명하고, 건너뛸지는 사람이 정한다

**처음 설계는 자동 재시도였다. 그것은 틀렸다.**

처음 이 문서는 프로토콜을 한 줄도 말하지 않고 즉사하면 `VOLTA_BYPASS=1` 을 얹어 **앱이 알아서** 한 번
다시 띄우라고 적었다. 그 결정의 근거였던 S7("기본으로 켜면 세션의 모든 자식이 상속받아 사용자가
핀해 둔 버전을 무시하게 된다")은 맞았는데, **재시도 경로에서도 똑같이 일어난다**는 것을 보지 못했다.
우회 변수는 재시도한 CLI 프로세스에 붙고, 그 CLI 가 세션 안에서 띄우는 모든 명령이 그것을 물려받는다 —
에이전트가 `npm test` 를 돌리면 그것도 우회되어, 그 프로젝트가 핀해 둔 Node 가 아닌 것으로 돈다. 조용히.
피하려던 피해를 다른 문으로 들인 셈이다.

**그리고 애초에 이것은 그 사람의 문제다.** 깨진 `package.json` 은 그의 프로젝트 버그이고, Volta 의
거절은 옳은 동작이다 — 어느 버전을 쓸지 정할 수 없으니 추측하지 않고 멈춘 것이다. 그 폴더에서는
`node`·`npm` 을 포함해 셤이 걸린 모든 명령이 똑같이 죽고, 그의 터미널에서도 그렇다. 앱이 말없이
우회하는 것은 남의 설정을 대신 뒤집는 일이다.

**그렇다고 막고 끝낼 수도 없다.** 그가 에이전트에게 시키려는 일이 하필 그 깨진 파일을 고치는 것일 수
있다. 막으면 고칠 수단 자체가 없어진다.

**그래서 설명하고, 고르게 한다.** 이 문서의 나머지가 내내 하는 일과 같다.

- 자동 재시도는 **없다**. CLI 가 죽으면 F1·F2 가 이유를 그대로 보여준다.
- 버튼은 **두 조건이 모두 참일 때만** 낸다.
  1. **죽은 모양이 "실행 자체가 거절됐다"** — 프로토콜을 한 줄도 말하지 않고 즉시 종료. 자동 재시도
     때 쓰던 것과 같은 행동 신호이고, 이제 재시도를 트리거하는 대신 버튼을 제안한다.
  2. **우회할 수 있는 관리자가 실제로 끼어 있다는 증거** — `checkCliInstalled` 가 쓰는 `locateCli` 는
     해석된 실행 파일 **경로**를 안다. 그것이 Volta 의 디렉터리 아래면 확정이고, 그 경로로 안 잡히는
     두 번째 문(`codex.cmd` 래퍼가 `node` 셤을 부르는 경우)은 `VOLTA_HOME` 으로 잡는다.

  **왜 둘 다인가.** 1번만 보면 DLL 누락·백신 차단·권한 문제·평범한 크래시로 죽었을 때도 버튼이 뜨고,
  아래 문구가 Volta 이야기를 확신에 차서 들려준다 — 아무 근거 없이. 그리고 눌러도 아무 일도 일어나지
  않는다(우회할 대상이 없으니). 1번만 참이고 2번이 거짓이면 **버튼 없이 F1·F2 의 설명만** 보여준다:
  우리가 모르는 원인에 대해 아는 척하지 않는 것이 이 문서 전체의 규칙이다. 문구가 Volta 를 이름으로
  부르는 것은 **탐지했기 때문**이지 추측이 아니다.
- 버튼은 바로 실행하지 않는다. **무엇을 포기하는지 먼저 말한다**(아래 문구). 사람이 확인해야 뜬다.
- 우회로 뜬 세션은 그 사실을 계속 달고 있는다(`notice`) — 나중에 결과를 읽을 때 "이 세션은 핀된 버전이
  아니었다" 가 보여야 한다.

#### 확인 창이 말해야 하는 것

한두 줄 규칙(S1)의 예외다. 여기서는 사람이 **대신할 수 없는 판단**을 하는 것이고, 판단에 필요한 사실을
빼면 버튼만 남는다. 네 가지를 말한다:

1. **무엇이 막았나** — 도구 자신의 말 그대로(`error: Could not parse project manifest`)와, 그것을 낸 것이
   CLI 가 아니라 PATH 앞의 버전 관리자라는 사실.
2. **건너뛰면 무슨 일이 생기나** — 버전 판단을 생략하고 기본으로 잡히는 CLI 를 그대로 실행한다. 세션은 뜬다.
3. **무엇을 포기하나** — 이 프로젝트에 핀해 둔 도구 버전. 이 세션과 **이 세션이 실행하는 모든 명령**
   (에이전트가 돌리는 `npm test`, `npm run build`, `node …`)이 핀된 버전이 아니라 기본 버전으로 돈다.
   같은 명령이 그의 터미널에서와 **다른 결과**를 낼 수 있다. — 이것이 이 창의 존재 이유이고, 빼면 안 된다.
4. **제대로 된 해결** — `package.json` 을 고치면 이 창은 다시 뜨지 않는다.

> 사용자가 렌더된 창을 보고 **"얼마나 오래 / 무엇이 바뀌나" 절을 빼라**고 했다(2026-09-21). 그 절이
> 지고 있던 사실 둘은 남아 있다 — 우회가 이 세션이 돌리는 모든 명령에 미친다는 것은 3번이 이미 말하고,
> 우회로 떴다는 사실은 세션에 계속 붙는 `notice` 가 말한다. 같이 사라진 것은 **롤 승계 문장**이다.
> 승계 자체는 조용히 일어나므로, 놀라는 사람이 나오면 더 짧은 자리에 다시 넣는다.
>
> 같은 요청으로 **문구의 `—` 를 전부 뺐다** — 라벨과 본문은 굵기로만 가르고, 도구가 남긴 줄은
> 콜론으로 잇는다. 새 세션 창의 "이 폴더에서 실행되지 않습니다" 경고도 같다.

## 5. 고치지 않는 것

Volta 자체, 리뷰어의 `package.json`, `cmd.exe /c` 의 PATH 해석(S5). 살아 있는 동안의 stderr
스트리밍(S2) — 필요해지면 그때 프로토콜에 더한다. 그리고 **우회를 기본값으로 켜는 것**(F5) —
사용자의 의도적인 버전 핀을 조용히 무시하는 쪽이 더 나쁜 고장이다.

## 6. 테스트

| 파일 | 고정하는 것 |
|---|---|
| `stderrTail.test.ts` (신규) | 아무것도 안 들어오면 `undefined`(빈 문자열과 다르다); 상한을 넘으면 **뒤**를 남긴다; 기본 상한이 `CheckResult.outputTail` 과 같은 4000 |
| `nodeProcFactory.test.ts` | 실제 자식이 stderr 에 찍고 죽으면 꼬리가 종료 이벤트에 실린다; 아무것도 안 찍으면 **키 자체가 없다** |
| `nodeProc.test.ts`·`procHost.test.ts`·`procFactory.test.ts` | Host 의 다섯 hop 이 꼬리를 나르고, 옛 Host 의 필드 없는 `proc-exit` 도 그대로 통과한다 |
| `adapterCore.test.ts` | 꼬리의 첫 줄이 `error`, 전문이 `errorDetail`, 코드가 `exitCode`; 꼬리가 없으면 지어내지 않고 이전 `error` 를 건드리지 않는다; 그 셋이 `exit` **이벤트**에도 실린다 |
| `codexAdapter.test.ts` / `claudeAdapter.test.ts` | 두 provider 가 같은 실패 모양을 낸다 |
| `useChatState.test.ts` | `foldChatEvent` 의 `exit` 갈래가 셋을 적용한다 — 이미 열린 pane 이 값을 받는 유일한 통로다 |
| `startBlocked.test.ts` (신규) | 여섯 사유의 우선순위(사람이 할 일 먼저, 대기 사유가 뒤), 아무것도 안 막으면 null, `starting` 중에는 사유가 없다 |
| `retryBypass.test.ts` (신규) | 말없이 즉사하면 한 번만 재시도; 한 줄이라도 말했으면 안 함; 오래 살았으면 안 함; `watchFirstLine` 이 줄을 흘려보내며 센다 |
| `manager.test.ts` | 재시도의 네 시퀀스를 **실제로 재현한다** — `kill()` 을 불러 생긴 종료는 재시도하지 않는다; 죽은 어댑터의 늦은 `error` 가 새 세션으로 새지 않는다; 성공한 재시도 뒤의 평범한 종료가 옛 실패를 사인으로 말하지 않는다; `initialPrompt` 를 0번은 안 보내고 재시도가 정확히 한 번 보낸다 |
| `paneTransport.test.ts` | 배너 우선순위 — 알림이 요청·에러 아래, 나머지 위 |
| `catalog.test.ts` | 네 카탈로그의 자리표시자·비어 있지 않음 (기존) |

렌더러는 `npm run typecheck` 와 `npm run build`. 수동 확인: PATH 앞에 즉시 `exit 8` 하며 stderr 를
뱉는 가짜 `codex` 를 놓고 대화 세션을 띄워, 배너가 코드와 그 문장을 말하는지 본다.
