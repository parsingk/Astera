// 설명 생성 에이전트에게 주는 프롬프트 — 스펙 §24 의 Explanation Contract 가 본문이다.
//
// **계약이 core 에 상수로 있는 이유:** 이 문장들이 배선(main) 안에 문자열로 흩어지면 어느
// 테스트도 "§24 의 14개 규칙이 다 들어 있는가"를 물을 수 없다. 스펙이 명시적 계약을 요구했으니
// 계약은 테스트가 닿는 자리에 있어야 한다 — titleOf 가 humanRequest.ts 에 있는 것과 같은 이유다.
//
// node: import 없음. 파일 내용은 부르는 쪽이 읽어 넣는다 — 이 모듈은 문자열만 만든다.
import type { Lang } from '../i18n'

/** What to call each language **inside the prompt**. The model is told to write in one of these, so
 *  the name is given in English — that is the language the rest of the prompt is in, and a model
 *  reading "한국어" in an otherwise English instruction has to infer that it is being named
 *  rather than quoted. The native name lives in i18n's CATALOGS and is for people, not for this. */
const LANGUAGE_NAME: Record<Lang, string> = { ko: 'Korean', en: 'English', ja: 'Japanese', es: 'Spanish' }

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

export interface RecordRequest {
  /** The app's language. The write-up is read on screen next to the app's own text, so it is
   *  written in the same language — without this the model picks one per run, and two records
   *  made minutes apart came back in different languages. */
  lang: Lang
  /** The user's own words, verbatim — for a Job, its objective */
  request: string
  changedFiles: readonly string[]
  /** Commit subjects in the unit's git range. Empty when nothing was committed. */
  commits: readonly string[]
  /** Job only: what the run's tasks were and how each ended */
  tasks?: readonly { title: string; outcome: string }[]
  /** Job only */
  validation?: { status: string; summary?: string }
  projectRoot: string
}

/** Ask for a write-up of **one piece of work that just finished** — not of the project.
 *
 *  The material is deliberately small (§29): the request, the files that changed, the commits in
 *  the range, and for a Job its tasks. Discovery used to hand over a repository skeleton and take
 *  ten minutes; there is nothing of that shape here, and the reading budget keeps it that way. */
export function buildRecordPrompt(req: RecordRequest): string {
  const language = LANGUAGE_NAME[req.lang]
  const jobSection =
    req.tasks && req.tasks.length > 0
      ? `\n\nTasks in this run and how each ended:\n` +
        req.tasks.map((t) => `- ${t.title} — ${t.outcome}`).join('\n')
      : ''
  const validation = req.validation
    ? `\n\nValidation: ${req.validation.status}${req.validation.summary ? ` — ${req.validation.summary}` : ''}`
    : ''
  const commits =
    req.commits.length > 0 ? `\n\nCommits in this range:\n${req.commits.map((c) => `- ${c}`).join('\n')}` : ''

  return `${EXPLANATION_CONTRACT}

You are writing up **one piece of work that just finished** in the project at ${req.projectRoot}.
Not what the project does — what this particular piece of work changed, and how.

What the person asked for, verbatim:
${req.request}

Files that changed while this work was open:
${req.changedFiles.map((f) => `- ${f}`).join('\n')}${commits}${jobSection}${validation}

Write every sentence a person reads in ${language}: "overview", "userVisibleChanges", every
"label", "description" and "condition" in "flow", every "title" and "reason" in "decisions", every
"role" in "implementation", and "needsReviewReason". File paths, node ids and the fixed values of
"type" stay as they are. Keep code identifiers in their original form and explain them in ${language}.

Read what you need to explain this change. Read only — never modify anything.

**Work to a budget: open at most 10 files, and stop as soon as every step has a file behind it.**
You are running in the background under a time limit; a write-up that never finishes is worth less
than a grounded one that does. If the budget runs out before you can ground something, say so in
"needsReview" rather than reading further.

${RECORD_OUTPUT_SHAPE}`
}

const RECORD_OUTPUT_SHAPE = `Respond with a single JSON object, no markdown fence, of this exact shape:
{
  "overview": string,               // 2-4 sentences on what is different now, contract rules apply
  "userVisibleChanges": string[],   // what a person using the product will notice; [] if none
  "flow": FlowNode[],               // the order things happen in, for the part that changed
  "decisions": { "title": string, "reason": string, "sourceLabel": string,
                 "evidencePaths": string[] }[],
  "implementation": { "role": string, "path": string }[],  // repo-relative, forward slashes
  "evidencePaths": string[],        // every file you actually read to ground this
  "needsReview": boolean,           // true when evidence was insufficient (rule 13)
  "needsReviewReason": string       // required when needsReview is true
}
FlowNode = { "id": string, "label": string, "type": "start"|"step"|"decision"|"success"|"failure",
             "description": string, "next": { "targetId": string, "condition"?: string }[],
             "evidencePaths": string[] }
Labels must be under 22 characters — a longer label means the step name became a sentence;
put the sentence in "description" instead. A "condition" is a tag on a branch, not a sentence:
keep it under 12 characters.

"flow" is drawn as a diagram and must be closed: every "targetId" must be the id of another node
in "flow".

Every step and every decision must name the files it is built from, in its own "evidencePaths".
The reader clicks a step to see what it rests on; a step that names nothing cannot be clicked.`

