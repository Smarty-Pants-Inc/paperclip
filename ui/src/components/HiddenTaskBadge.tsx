import { EyeOff } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

/** Marks a hidden task in lists that include hidden tasks. */
export function HiddenTaskBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      data-slot="hidden-task-badge"
      className={cn("ml-1.5 px-1.5 text-(length:--text-nano) text-muted-foreground", className)}
      title="This task is hidden"
    >
      <EyeOff className="h-3 w-3" aria-hidden="true" />
      Hidden
    </Badge>
  );
}
