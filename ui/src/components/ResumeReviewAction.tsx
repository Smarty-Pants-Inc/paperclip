import { useMutationState, useQueryClient } from "@tanstack/react-query";
import type { IssueThreadInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useAccountBoundMutation } from "@/hooks/useAccountBoundMutation";
import { queryKeys } from "@/lib/queryKeys";
import { interactionResolutionErrorMessage } from "@/lib/interaction-resolution-error";
import { Button } from "@/components/ui/button";

/** Reserve the same footprint before capability loads, during work, and after
 * eligibility disappears. Non-native confirmations keep their existing layout. */
export function ResumeReviewAction({ interaction, disabled = false }: {
  interaction: RequestConfirmationInteraction; disabled?: boolean;
}) {
  const target = interaction.payload.target;
  const nativeReview = target?.type === "custom" && target.key === "native_completion_review";
  if (!nativeReview && interaction.canResumeReview !== true) return null;
  return <div data-resume-review-slot className="flex h-20 shrink-0 flex-col gap-1">
    {interaction.status === "pending" && interaction.canResumeReview === true
      ? <AllowedResumeReviewAction interaction={interaction} disabled={disabled} /> : null}
  </div>;
}

function AllowedResumeReviewAction({ interaction, disabled }: {
  interaction: RequestConfirmationInteraction; disabled: boolean;
}) {
  const client = useQueryClient();
  const mutationKey = ["resume-review", interaction.companyId, interaction.issueId, interaction.id];
  // The timeline and open card are separate trees. Observe the same cache rather
  // than treating each button's mutation as an independent in-flight operation.
  const pending = useMutationState({ filters: { mutationKey, exact: true, status: "pending" },
    select: () => true }).length > 0;
  const resume = useAccountBoundMutation({
    mutationKey,
    mutationFn: () => issuesApi.resumeReview(interaction.issueId, interaction.id),
    onSuccess: () => {
      client.setQueryData<IssueThreadInteraction[]>(queryKeys.issues.interactions(interaction.issueId),
        rows => rows?.map(row => row.id === interaction.id ? { ...row, canResumeReview: false } : row));
      void client.invalidateQueries({ queryKey: ["issues"] });
    },
  });
  return <>
    <Button type="button" size="sm" variant="outline" className="h-8 w-44 max-w-full shrink-0"
      disabled={disabled || pending || resume.isSuccess} aria-busy={pending}
      onClick={() => {
        // Cache status changes synchronously in mutate(), before React rerenders:
        // two presses in one event turn still create only one mutation per card.
        if (disabled || client.getMutationCache().find({ mutationKey, exact: true, status: "pending" })) return;
        resume.mutate();
      }}>
      {pending ? "Resuming review…" : resume.isSuccess ? "Review resumed" : "Resume review"}
    </Button>
    {resume.error ? <p role="alert" className="min-h-0 flex-1 overflow-y-auto text-sm text-destructive">{interactionResolutionErrorMessage(resume.error)}</p> : null}
  </>;
}
