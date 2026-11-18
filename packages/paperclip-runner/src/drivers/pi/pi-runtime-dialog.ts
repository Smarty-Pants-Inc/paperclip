import { parsePaperclipQuestionResponse, parsePaperclipQuestionSet, type PaperclipQuestionSet } from "../../contracts/question-set.js";
import type { PiRpcRecord } from "./pi-rpc-transport.js";

/** Diagnostic provider identity only. Run/turn/epoch authority stays in the driver. */
export const PI_RUNTIME_DIALOG_ORIGIN = Object.freeze({ adapter: "pi-rpc", provider: "pi_rpc", method: "extension_ui_request" });
export type PiRuntimeDialogMethod = "select" | "confirm" | "input" | "editor";
export interface PiRuntimeDialog {
  method: PiRuntimeDialogMethod;
  input: PaperclipQuestionSet;
  timeout?: number;
}

/** The four documented Pi RPC dialogs use the existing canonical question seam. */
export function normalizePiRuntimeDialog(event: PiRpcRecord): PiRuntimeDialog {
  const method = event.method;
  if (event.type !== "extension_ui_request" || !["select", "confirm", "input", "editor"].includes(String(method))) throw new Error("Invalid Pi UI method");
  if (typeof event.title !== "string" || !event.title || event.title.length > 4000) throw new Error("Invalid Pi UI title");
  for (const field of ["message", "placeholder", "prefill"]) if (event[field] !== undefined && typeof event[field] !== "string") throw new Error(`Invalid Pi UI ${field}`);
  if (method === "confirm" && typeof event.message !== "string") throw new Error("Invalid Pi UI message");
  if (event.timeout !== undefined && (typeof event.timeout !== "number" || !Number.isFinite(event.timeout) || event.timeout < 0)) throw new Error("Invalid Pi UI timeout");
  let options: Array<{ id: string; label: string }> | undefined;
  if (method === "select") {
    if (!Array.isArray(event.options) || !event.options.length || event.options.length > 128 || !event.options.every(value => typeof value === "string" && value.length > 0 && value.length <= 1000)) throw new Error("Invalid Pi UI options");
    options = event.options.map((label, index) => ({ id: `option-${index + 1}`, label: label as string }));
  } else if (method === "confirm") options = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
  const input = parsePaperclipQuestionSet({ schema: "paperclip.question_set.v1", questions: [{
    id: "value", prompt: event.title, required: options !== undefined, answerMode: options ? "single_select" : "text",
    ...(options ? { options } : {}),
    ...(method === "confirm" && event.message ? { helpText: event.message } : {}),
    ...(method === "input" && event.placeholder ? { helpText: event.placeholder } : {}),
    ...(method === "editor" && event.prefill !== undefined ? { initialText: event.prefill } : {}),
  }] });
  return { method: method as PiRuntimeDialogMethod, input, ...(event.timeout ? { timeout: event.timeout as number } : {}) };
}

export function piRuntimeDialogReply(dialog: PiRuntimeDialog, id: string | number, resolution: unknown): { id: string | number; value?: string; confirmed?: boolean; cancelled?: true } {
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) throw new Error("Pi UI resolution refused");
  const value = resolution as Record<string, unknown>;
  if (value.action === "cancel" || value.action === "decline") {
    if (Object.keys(value).some(key => key !== "action")) throw new Error("Pi UI cancellation carries answer data");
    return { id, cancelled: true };
  }
  if (value.action !== "submit" || Object.keys(value).some(key => !["action", "response"].includes(key))) throw new Error("Pi UI requires a canonical question response");
  const response = parsePaperclipQuestionResponse(dialog.input, value.response);
  const answer = response.answers.value;
  if (dialog.method === "confirm") return { id, confirmed: answer?.selectedOptionIds?.[0] === "yes" };
  if (dialog.method === "select") {
    const selected = dialog.input.questions[0]!.options!.find(option => option.id === answer?.selectedOptionIds?.[0]);
    if (!selected) throw new Error("Pi UI requires an offered choice");
    return { id, value: selected.label };
  }
  // Canonical optional text omits blank answers; Pi supports the empty string.
  const raw = value.response as { answers?: { value?: { text?: string } } };
  return { id, value: answer?.text ?? raw.answers?.value?.text ?? "" };
}
