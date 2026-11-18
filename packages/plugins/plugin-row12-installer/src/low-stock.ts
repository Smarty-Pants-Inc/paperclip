export interface LowStockInboxDecision {
  lowStock: boolean;
  deduplicationKey: string;
  existingKeys: ReadonlySet<string>;
}

/** Caller-side gate: create at most one inbox item for each stable key. */
export function shouldCreateLowStockInboxItem(input: LowStockInboxDecision): boolean {
  return input.lowStock && input.deduplicationKey.length > 0 && !input.existingKeys.has(input.deduplicationKey);
}
