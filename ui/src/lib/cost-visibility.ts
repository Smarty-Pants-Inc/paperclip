import type { AttentionItem } from "@paperclipai/shared";

// Paul 11-16: hide money UI until reviewed for accuracy; APIs stay untouched for agents and the money job.
export const COST_BUDGET_UI_HIDDEN = true;

export function isHiddenMoneyAction(action: string): boolean {
  return COST_BUDGET_UI_HIDDEN && /(^cost\.|budget|spend)/i.test(action);
}

export function isHiddenMoneyAttentionItem(item: AttentionItem): boolean {
  return COST_BUDGET_UI_HIDDEN && (item.sourceKind === "budget_alert" || item.subject.metadata?.type === "budget_override_required");
}
