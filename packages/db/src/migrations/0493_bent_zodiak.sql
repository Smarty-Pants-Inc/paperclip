CREATE TABLE "native_run_diagnostics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"loss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_run_diagnostics" ADD CONSTRAINT "native_run_diagnostics_company_id_issue_id_run_id_heartbeat_runs_company_id_native_issue_id_id_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_run_diagnostics_run_idx" ON "native_run_diagnostics" USING btree ("company_id","run_id");