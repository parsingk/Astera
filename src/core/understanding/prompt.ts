// 설명 생성 에이전트에게 주는 프롬프트 — 스펙 §24 의 Explanation Contract 가 본문이다.
//
// **계약이 core 에 상수로 있는 이유:** 이 문장들이 배선(main) 안에 문자열로 흩어지면 어느
// 테스트도 "§24 의 14개 규칙이 다 들어 있는가"를 물을 수 없다. 스펙이 명시적 계약을 요구했으니
// 계약은 테스트가 닿는 자리에 있어야 한다 — titleOf 가 humanRequest.ts 에 있는 것과 같은 이유다.
//
// node: import 없음. 파일 내용은 부르는 쪽이 읽어 넣는다 — 이 모듈은 문자열만 만든다.
import type { ProjectFeature } from './types'

/** 스펙 §24 전문. **줄이지 않는다** — 이 계약의 요점은 AI 가 기술 용어로 도망가지 못하게
 *  명시적으로 막는 것이고, 조항을 빼는 순간 그 구멍으로 도망간다. §25(Vocabulary Guard)의
 *  요지를 7-1 로 함께 싣는다. */
export const EXPLANATION_CONTRACT = `You are explaining how this project works to a product manager who understands
software products but does not know this codebase.

Rules:

1. Explain behavior before implementation.
2. Begin with what the user or system is trying to accomplish.
3. Explain the flow in chronological order.
4. Do not lead with class, function, variable, database-table or internal
   module names.
5. If a technical term is necessary, immediately explain it in plain language.
6. Never assume the reader understands project-specific terminology.
7. Prefer:
   "The server checks whether the user already exists."

   Instead of:
   "UserIdentityResolver queries PrincipalRepository."
7-1. Never use project-specific jargon without explaining it first. Internal
   names belong in the Implementation section only.
8. Separate:
   - What happens
   - Why it happens
   - How it is implemented
9. Include only important failure paths.
10. Put code/file/class details in the Implementation section.
11. Do not invent behavior.
12. Every important behavior must be grounded in supplied evidence.
13. If evidence is insufficient or conflicting, say that the explanation needs
    review instead of guessing.
14. Do not include private reasoning or chain-of-thought.`

/** 출력 스키마의 산문 설명. JSON 스키마 파일 대신 프롬프트에 싣는 이유: claude 의 -p 는
 *  --output-format json 로 겉봉투만 보장하고 내용 스키마는 계약이 지켜야 한다. 검증은 어차피
 *  validate.ts 가 다시 한다 — 여기는 에이전트가 맞출 과녁을 보여 주는 자리다. */
export const OUTPUT_SHAPE = `Respond with a single JSON object, no markdown fence, of this exact shape:
{
  "overview": string,            // 2-4 sentences, contract rules apply
  "userFlow": FlowNode[],        // the main path, chronological
  "failureFlows": FlowNode[],    // only important failures (rule 9)
  "keyDecisions": { "title": string, "reason": string, "sourceLabel": string,
                    "evidencePaths": string[] }[],
  "implementation": { "role": string, "path": string }[],  // repo-relative paths, forward slashes
  "evidencePaths": string[],     // every file you actually read to ground this
  "needsReview": boolean,        // true when evidence was insufficient (rule 13)
  "needsReviewReason": string    // required when needsReview is true
}
FlowNode = { "id": string, "label": string, "type": "start"|"step"|"decision"|"success"|"failure",
             "description": string, "next": { "targetId": string, "condition"?: string }[],
             "evidencePaths": string[] }
Labels must be under 22 characters — a longer label means the step name became a sentence;
put the sentence in "description" instead.

Every step and every decision must name the files it is built from, in its own "evidencePaths".
The reader clicks a step to see what it rests on; a step that names nothing cannot be clicked, so
the reader is left with a diagram they cannot open. Name the file you actually read for that step,
not the whole feature's file list.`

export interface ExplainRequest {
  feature: Pick<ProjectFeature, 'id' | 'name' | 'summary'>
  /** 이 기능의 구현 경로들 — 에이전트가 읽을 곳. 첫 분석이 만든 것이거나 지난 설명의 것 */
  implementationPaths: readonly string[]
  /** 이번 재생성을 일으킨 변화. 첫 생성이면 빈 목록 */
  recentChangeBodies: readonly string[]
  /** 프로젝트 루트 — 에이전트의 작업 디렉터리가 이곳이라는 사실을 문장으로 알려 준다 */
  projectRoot: string
}

/** 기능 하나의 설명을 만들어 달라는 프롬프트 전문 */
export function buildExplainPrompt(req: ExplainRequest): string {
  const changes =
    req.recentChangeBodies.length > 0
      ? `\n\nRecent changes that triggered this update (user requests, verbatim):\n` +
        req.recentChangeBodies.map((b) => `- ${b}`).join('\n')
      : ''
  return `${EXPLANATION_CONTRACT}

Feature to explain: ${req.feature.name}
One-line summary so far: ${req.feature.summary}

Start from these implementation paths (repo-relative, under ${req.projectRoot}) and read what you
need to ground the explanation. Read only — never modify anything:
${req.implementationPaths.map((p) => `- ${p}`).join('\n')}${changes}

${OUTPUT_SHAPE}`
}

/** 첫 분석 — 기능 목록 초안을 만들어 달라는 프롬프트 (스펙 §21). 설명은 만들지 않는다.
 *
 *  **재료를 함께 준다 (스펙 §29).** "저장소를 보고 찾아라"라고만 했더니 이 저장소(572개 파일)에서
 *  10분을 넘겨도 끝나지 않았다 — 에이전트가 파일을 하나씩 열어 보는 것을 막지 않았기 때문이다.
 *  §29 가 그것을 미리 금지했다: "전체 repository 를 prompt 에 넣지 않는다 … deterministic
 *  heuristic 으로 충분하다." 그래서 디렉터리 뼈대와 문서 앞부분을 값으로 실어 준다.
 *
 *  @param sketch collectSketch 가 모아 sketchText 로 다듬은 문자열 */
export function buildDiscoverPrompt(projectRoot: string, sketch: string): string {
  return `You are cataloguing what a software project does, for a product manager.

Below is the shape of the repository at ${projectRoot} — its directory skeleton and the opening
of its main documents. **Work from this.** Open a file only when you cannot name a feature without
it, and never more than a handful. Read only; never modify anything.

${sketch}

Rules 4-7 and 11-14 of the following contract apply to names and summaries:

${EXPLANATION_CONTRACT}

Respond with a single JSON object, no markdown fence:
{
  "features": [
    {
      "name": string,        // feature name a user would recognise — "인증", not "AuthService"
      "summary": string,     // one line for a sidebar row
      "implementationPaths": string[]  // repo-relative paths where this feature lives
    }
  ]
}
List 3 to 12 features. Every path must be one that exists — prefer a directory from the skeleton
above over a file you have not opened. The result is a draft the user can rename or remove: prefer
missing a minor feature over inventing one.`
}
