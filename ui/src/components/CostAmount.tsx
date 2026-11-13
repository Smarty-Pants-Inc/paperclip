import type { ReactNode } from "react";
import type { CostByAgent } from "@paperclipai/shared";
import { formatCents, usageCompletenessLabel } from "../lib/utils";
import { CostEstimateLabel } from "./CostEstimateLabel";
import { Badge } from "./ui/badge";

export function CostAmount({
  costCents,
  eventCount,
  estimatedEventCount,
  accountingUsageLost,
  unpricedEventCount,
  showUnavailableCount = false,
  suffix,
}: Pick<CostByAgent, "costCents"> & Partial<Pick<CostByAgent, "eventCount" | "estimatedEventCount" | "accountingUsageLost">> & {
  unpricedEventCount?: number;
  showUnavailableCount?: boolean;
  suffix?: ReactNode;
}) {
  const usageQualifier = usageCompletenessLabel({ accountingUsageLost });
  const entirelyUnpriced = costCents === 0 && (eventCount ?? 0) > 0 && unpricedEventCount === eventCount;
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <div className="whitespace-nowrap font-mono font-medium tabular-nums">
        {entirelyUnpriced ? "—" : formatCents(costCents)}
        {suffix}
      </div>
      <CostEstimateLabel eventCount={eventCount} estimatedEventCount={estimatedEventCount} />
      {usageQualifier && <span className="text-xs text-muted-foreground">{usageQualifier}</span>}
      {showUnavailableCount && !!unpricedEventCount && <Badge variant="outline" className="font-normal text-muted-foreground">
        {unpricedEventCount} {unpricedEventCount === 1 ? "cost" : "costs"} unavailable
      </Badge>}
    </div>
  );
}
