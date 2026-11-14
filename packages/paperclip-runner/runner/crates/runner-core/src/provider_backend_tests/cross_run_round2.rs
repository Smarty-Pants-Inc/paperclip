mod cross_run_round2 {
    use super::*;

    // Keep: C8 migration is an authenticated attachment boundary, not ownership
    // inferred from a changed contract. Preserve all unsettled-work fences.
    #[test]
    fn legacy_attachment_keeps_live_work_and_profile_fences() {
        for blocker in [
            "no_authority",
            "config",
            "active",
            "ambiguous",
            "tool",
            "startup",
            "receipt",
            "descendant",
            "event",
            "goal",
        ] {
            let (directory, mut payload) = prepared_contract_checkpoint();
            let mut next = restore_contract_checkpoint(&directory, "run-B");
            let state = next.state.as_mut().unwrap();
            state.run_identity = None;
            match blocker {
                "config" => payload["provider"]["model"] = json!("foreign-model"),
                "active" => {
                    state.active_provider_turn_id = Some("old-turn".to_owned());
                    state.lifecycle = "turn_active".to_owned();
                }
                "ambiguous" => {
                    state.ambiguous_turn_start_pending = true;
                    state.lifecycle = "session_open".to_owned();
                }
                "tool" => {
                    state.tool_bridge =
                        tool_result_authority_state("codex", "get_task_context").tool_bridge;
                    state
                        .tool_bridge
                        .begin_call(
                            "old-call".to_owned(),
                            "get_task_context".to_owned(),
                            json!({}),
                        )
                        .unwrap();
                }
                "receipt" => {
                    state.lifecycle = "turn_active".to_owned();
                    state.active_provider_turn_id = Some("old-turn".to_owned());
                    state.receipt_limit_diagnostic_emitted = true;
                    state.receipt_limit_interrupt_pending = true;
                }
                "descendant" => {
                    state.descendant_thread_ids.insert("old-child".to_owned());
                }
                "event" => state
                    .push_event(NormalizedProviderEvent {
                        event_type: "turn.completed".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({}),
                    })
                    .unwrap(),
                "goal" => {
                    state.goal = Some(SessionGoalSnapshot {
                        objective: "Old work".to_owned(),
                        status: "active".to_owned(),
                        token_budget: None,
                        tokens_used: 0,
                        elapsed_seconds: 0,
                        iterations: 0,
                        last_reason: None,
                        created_at: None,
                        updated_at: None,
                        completed_at: None,
                        working_now: false,
                    })
                }
                _ => {}
            }
            if blocker == "no_authority" {
                next.event_identity = None;
            }
            payload["completionContract"]["revision"] = json!("revision-2");
            if blocker == "startup" {
                next.begin_startup(ProviderStartupTrigger::Ensure, 2)
                    .unwrap();
            }
            next.save_state()
                .unwrap_or_else(|error| panic!("{blocker}: {error}"));
            let before = fs::read(next.state_path()).unwrap();
            let before_state = next.state.clone();
            assert!(
                next.prepare_with_legacy_attachment(&payload, true).is_err(),
                "{blocker}"
            );
            assert_eq!(fs::read(next.state_path()).unwrap(), before, "{blocker}");
            assert_eq!(next.state, before_state, "{blocker}");
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn public_legacy_prepare_attaches_once_then_enforces_same_run_contract() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        let path = directory.join("codex-provider-state.json");
        let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("runIdentity");
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut next = CodexCommandExecutor::new(&directory);
        next.event_identity = Some(prepare_contract_identity("run-B"));
        payload["completionContract"]["revision"] = json!("revision-2");
        payload["paperclipNextAuthority"] = json!({"identity":{"runId":"untrusted-nomination"}});
        let command = |seq, payload| crate::durable::Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: format!("prepare-{seq}"),
            controller_seq: seq,
            command_type: "run.prepare".to_owned(),
            issued_at: "2026-11-14T00:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        };
        next.execute(&command(1, payload.clone())).unwrap();
        assert_eq!(
            next.state
                .as_ref()
                .unwrap()
                .run_identity
                .as_ref()
                .unwrap()
                .run_id,
            "run-B"
        );
        let bound = fs::read(&path).unwrap();
        next.execute(&command(2, payload.clone())).unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            bound,
            "repeat prepare does not attach again"
        );
        payload["completionContract"]["revision"] = json!("revision-3");
        assert!(next.execute(&command(3, payload)).is_err());
        assert_eq!(
            fs::read(&path).unwrap(),
            bound,
            "same-run contract refusal preserves the snapshot"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
