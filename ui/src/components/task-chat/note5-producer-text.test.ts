import { describe, expect, it } from "vitest";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";

const ts = "2026-11-17T00:00:00Z";
const full = "Question text. ".repeat(900) + "LAST_PROVIDER_BYTE";
function parse(eventType: string, payload: Record<string, unknown>) {
  return paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({ type: "paperclip.prp.event", event: { eventType, payload } }), ts)[0];
}
describe("NOTE 5: producer-authored UI requests and results", () => {
  it("keeps full question labels, prompts, help, options and submitted answers", () => {
    const item = parse("runtime_request.opened", { requestId: "note5-question", requestKind: "user_input", type: "input", choices: Array.from({ length: 33 }, (_, i) => ({ key: String(i), label: full })), details: { fields: Array.from({ length: 17 }, (_, i) => ({ name: `field-${i}`, label: full, placeholder: full })) }, input: { schema: "paperclip.question_set.v1", title: full, submitLabel: full, questions: Array.from({ length: 65 }, (_, i) => ({ id: `q-${i}`, prompt: full, header: full, helpText: full, answerMode: "single_select", options: Array.from({ length: i === 64 ? 129 : 1 }, (_, j) => ({ id: `option-${j}`, label: full, description: full })), customAnswer: { enabled: true, label: full, placeholder: full } })) }, response: { schema: "paperclip.question_response.v1", answers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q-${i}`, { text: full, customText: full }])) } });
    if (item?.kind !== "runtime_request") throw new Error("expected input request");
    expect(item.choices).toHaveLength(33);
    expect(item.fields).toHaveLength(17);
    expect(item.fields.at(-1)).toMatchObject({ label: full, placeholder: full });
    expect(item.questionSet).toMatchObject({ title: full, submitLabel: full });
    expect(item.questionSet?.questions).toHaveLength(65);
    const question = item.questionSet?.questions.at(-1);
    expect(question).toMatchObject({ prompt: full, header: full, helpText: full, customAnswer: { label: full, placeholder: full } });
    expect(question?.options).toHaveLength(129);
    expect(question?.options?.at(-1)).toMatchObject({ label: full, description: full });
    expect(item.response?.answers["q-64"]).toMatchObject({ text: full, customText: full });
  });
  it("keeps all reported verification, remaining-work and artifact rows", () => {
    const item = parse("run.result.proposed", { summary: full, verification: Array.from({ length: 65 }, () => ({ commandOrCheck: full, detail: full })), completionClaim: { remainingWork: Array.from({ length: 65 }, () => ({ description: full })) }, artifacts: Array.from({ length: 65 }, (_, i) => ({ ref: `artifact-${i}`, title: full })) });
    if (item?.kind !== "run_result") throw new Error("expected result");
    expect(item.verification).toHaveLength(65);
    expect(item.remainingWork).toHaveLength(65);
    expect(item.artifacts).toHaveLength(65);
  });
});
