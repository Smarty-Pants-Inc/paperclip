import { useQueryClient } from "@tanstack/react-query";
import type { IssueThreadInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useAccountBoundMutation } from "@/hooks/useAccountBoundMutation";
import { queryKeys } from "@/lib/queryKeys";
import { interactionResolutionErrorMessage } from "@/lib/interaction-resolution-error";
import { Button } from "@/components/ui/button";

/** Eligibility is server-owned. Absence is a denial, including historical cards. */
export function ResumeReviewAction({ interaction, disabled = false }: {
  interaction: RequestConfirmationInteraction; disabled?: boolean;
}) {
  if (interaction.status !== "pending" || interaction.canResumeReview !== true) return null;
  return <AllowedResumeReviewAction interaction={interaction} disabled={disabled} />;
}

function AllowedResumeReviewAction({ interaction, disabled }: {
  interaction: RequestConfirmationInteraction; disabled: boolean;
}) {
  const client = useQueryClient();
  const resume = useAccountBoundMutation({
    mutationFn: () => issuesApi.resumeReview(interaction.issueId, interaction.id),
    onSuccess: () => {
      // Hide immediately, even if a cached bootstrap responds before the run arrives.
      client.setQueryData<IssueThreadInteraction[]>(queryKeys.issues.interactions(interaction.issueId),
        rows => rows?.map(row => row.id === interaction.id ? { ...row, canResumeReview: false } : row));
      void client.invalidateQueries({ queryKey: ["issues"] });
    },
  });
  return <>
    <Button type="button" size="sm" variant="outline" disabled={disabled || resume.isPending || resume.isSuccess}
      onClick={() => resume.mutate()}>
      {resume.isPending ? "Resuming review…" : resume.isSuccess ? "Review resumed" : "Resume review"}
    </Button>
    {resume.error ? <p role="alert" className="text-sm text-destructive">{interactionResolutionErrorMessage(resume.error)}</p> : null}
  </>;
}
