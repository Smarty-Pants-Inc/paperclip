mod skill_edit {
    use super::*;

    // Keep: durable cross-process admission must queue skill edits rather than
    // fail a run or mutate instructions while the predecessor owns work.
    #[test]
    fn skill_edit_live_work_prepare_waits_for_boundary() {
        refresh_admission("active_turn", "refresh_wait");
    }

    #[test]
    fn skill_edit_deferred_terminal_prepare_waits_for_boundary() {
        refresh_admission("deferred_terminal", "refresh_wait");
    }

    #[test]
    fn skill_edit_descendant_prepare_waits_for_boundary() {
        refresh_admission("descendant", "refresh_wait");
    }

    #[test]
    fn skill_edit_active_goal_prepare_selects_fresh_history() {
        refresh_admission("goal", "refresh_fresh");
    }

    #[test]
    fn skill_edit_contract_prepare_selects_fresh_history() {
        refresh_admission("contract", "refresh_fresh");
    }

    fn refresh_admission(blocker: &str, expected: &str) {
        let provider = if blocker == "deferred_terminal" {
            "pi_rpc"
        } else {
            "codex"
        };
        let (directory, mut old, mut payload) = prepared_skill_checkpoint(provider, true);
        let state = old.state.as_mut().unwrap();
        state.run_identity = Some(prepare_contract_identity("run-A"));
        match blocker {
            "active_turn" => {
                state.active_provider_turn_id = Some("old-turn".to_owned());
                state.lifecycle = "turn_active".to_owned();
            }
            "deferred_terminal" => {
                state.tool_bridge =
                    tool_result_authority_state("pi_rpc", "get_task_context").tool_bridge;
                state
                    .tool_bridge
                    .begin_call(
                        "deferred-call".to_owned(),
                        "get_task_context".to_owned(),
                        json!({}),
                    )
                    .unwrap();
                state.tool_bridge.settle_turn("turn_completed").unwrap();
                state.pi_deferred_terminal = Some("turn.completed".to_owned());
            }
            "descendant" => {
                state
                    .descendant_thread_ids
                    .insert("child-thread".to_owned());
            }
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
            "contract" => {
                payload["completionContract"] =
                    json!({"revision":"new-contract", "criterionIds":["objective"]})
            }
            _ => unreachable!(),
        }
        old.save_state().unwrap();
        let bytes = fs::read(old.state_path()).unwrap();
        // A genuinely different executor reads the old owner's saved state.
        let mut next = CodexCommandExecutor::new(&directory);
        next.pi_launch_profile = old.pi_launch_profile.clone();
        next.event_identity = Some(prepare_contract_identity("run-B"));
        payload["provider"]["instructions"] = json!("Edited skill: M14_ONLY_NEW_SKILL_MARKER");
        let result = next.execute(&crate::durable::Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: "next-prepare".to_owned(),
            controller_seq: 1,
            command_type: "run.prepare".to_owned(),
            issued_at: "2026-11-14T09:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        });
        assert!(
            result.is_ok(),
            "{blocker}: prepare must select {expected}, not fail: {result:?}"
        );
        assert_eq!(result.unwrap().result["status"], expected, "{blocker}");
        assert_eq!(
            fs::read(old.state_path()).unwrap(),
            bytes,
            "admission must not rewrite predecessor"
        );
        // A no-op prepare receipt is not sufficient: the contender's ordinary
        // event pump and close must not restore, reconcile, or stop old work.
        let events = next
            .poll_events()
            .expect("waiting admission must not restore the old provider");
        assert!(
            events.is_empty(),
            "old-owner events cannot acquire the contender's authority"
        );
        next.shutdown()
            .expect("unadmitted contender cleanup must not restore the old provider");
        assert_eq!(
            fs::read(old.state_path()).unwrap(),
            bytes,
            "poll/cleanup must preserve the predecessor"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    // Keep: TL07 (open conversation) and TL08 (DONE-task follow-up). A new
    // invocation must see the edited assigned skill, without changing the
    // provider, skill-inclusion policy, tools or completion contract.
    #[test]
    fn codex_prepare_skill_edit_refreshes_only_instructions_across_runs() {
        prepare_skill_edit_refreshes_only_instructions_across_runs("codex");
    }

    #[test]
    fn pi_prepare_skill_edit_refreshes_only_instructions_across_runs() {
        prepare_skill_edit_refreshes_only_instructions_across_runs("pi_rpc");
    }

    fn prepare_skill_edit_refreshes_only_instructions_across_runs(provider: &str) {
        for done in [false, true] {
            let (directory, mut executor, mut payload) = prepared_skill_checkpoint(provider, true);
            let state = executor.state.as_mut().unwrap();
            state.run_identity = Some(prepare_contract_identity("run-A"));
            state.completed_turn_authoritative = true;
            state.completed_provider_turn_id = Some("old-turn".to_owned());
            state.completed_turn_process_generation = Some(1);
            state
                .settled_provider_turn_ids
                .insert("old-turn".to_owned());
            // DONE is a server disposition, not a closed provider session.
            state.last_agent_message = Some(if done { "Done" } else { "Still open" }.to_owned());
            executor.save_state().unwrap();
            let before = executor.state.as_ref().unwrap().clone();
            executor.event_identity = Some(prepare_contract_identity("run-B"));
            payload["provider"]["instructions"] = json!("Assigned skill: edited description v2");
            let mut stable: CodexProviderConfig =
                serde_json::from_value(payload["provider"].clone()).unwrap();
            if provider != "codex" {
                stable.include_skill_instructions = None;
            }
            assert_ne!(before.config.instructions, stable.instructions);
            stable.instructions = before.config.instructions.clone();
            assert_eq!(
                before.config, stable,
                "instructions are the ONLY config diff"
            );
            assert_eq!(
                before.completion_contract,
                completion_contract(&payload).unwrap()
            );
            assert!(before.is_settled_for_run_attachment());
            assert!(before.pi_deferred_terminal.is_none());
            assert!(before.descendant_thread_ids.is_empty());
            eprintln!("SKILL_EDIT provider={provider} done={done} different_run=true rebind_run=true config_diff=[instructions] completion_contract_equal=true include_skill_instructions_equal=true tools_equal=true");
            executor.prepare(&payload).unwrap_or_else(|error| {
                panic!(
                    "{provider} done={done}: instructions-only cross-run refresh refused: {error}"
                )
            });
            let state = executor.state.as_ref().unwrap();
            assert_eq!(
                state.config.instructions,
                payload["provider"]["instructions"]
            );
            assert_eq!(state.thread_id, before.thread_id);
            assert_eq!(state.run_identity.as_ref().unwrap().run_id, "run-B");
            assert_eq!(state.completion_contract, before.completion_contract);
            assert_eq!(
                state.config.include_skill_instructions,
                before.config.include_skill_instructions
            );
            assert!(state.last_agent_message.is_none());
            assert!(!state.completed_turn_authoritative);
            let mut recovered = CodexCommandExecutor::new(&directory);
            recovered.pi_launch_profile = executor.pi_launch_profile.clone();
            recovered.load_state_without_provider().unwrap();
            assert_eq!(recovered.state, executor.state);
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn prepare_skill_edit_keeps_same_run_and_other_profile_fields_immutable() {
        for provider in ["codex", "pi_rpc"] {
            for field in [
                "same_run",
                "model",
                "command",
                "args",
                "cwd",
                "readOnly",
                "conversationMode",
                "includeSkillInstructions",
                "completionContract",
            ] {
                if provider == "pi_rpc" && field == "includeSkillInstructions" {
                    continue; // Pi has always normalized this Codex-only field away.
                }
                let (directory, mut executor, mut payload) =
                    prepared_skill_checkpoint(provider, true);
                executor.state.as_mut().unwrap().run_identity =
                    Some(prepare_contract_identity("run-A"));
                executor.event_identity = Some(prepare_contract_identity(
                    if field == "same_run" || field == "completionContract" {
                        "run-A"
                    } else {
                        "run-B"
                    },
                ));
                executor.save_state().unwrap();
                let before = executor.state.clone();
                let bytes = fs::read(executor.state_path()).unwrap();
                payload["provider"]["instructions"] = json!("Edited skill v2");
                match field {
                    "model" => payload["provider"][field] = json!("other/model"),
                    "command" => payload["provider"][field] = json!("/bin/false"),
                    "args" => payload["provider"][field] = json!(["different"]),
                    "cwd" => payload["provider"][field] = json!("/different-workspace"),
                    "readOnly" => payload["provider"][field] = json!(true),
                    "conversationMode" => payload["provider"][field] = json!("prepared"),
                    "includeSkillInstructions" => payload["provider"][field] = json!(false),
                    "completionContract" => {
                        payload[field] = json!({"revision":"changed", "criterionIds":["objective"]})
                    }
                    _ => {}
                }
                assert!(executor.prepare(&payload).is_err(), "{provider}: {field}");
                assert_eq!(executor.state, before, "{provider}: {field}");
                assert_eq!(
                    fs::read(executor.state_path()).unwrap(),
                    bytes,
                    "{provider}: {field}"
                );
                fs::remove_dir_all(directory).unwrap();
            }
        }
    }

    #[test]
    fn codex_attach_skill_edit_requires_new_owner_and_unchanged_profile() {
        for variation in ["new_run", "same_run", "model", "descendant"] {
            let (directory, mut executor, mut payload) = prepared_skill_checkpoint("codex", true);
            executor.state.as_mut().unwrap().run_identity =
                Some(prepare_contract_identity("run-A"));
            executor.event_identity = Some(prepare_contract_identity("run-A"));
            if variation == "descendant" {
                executor
                    .state
                    .as_mut()
                    .unwrap()
                    .descendant_thread_ids
                    .insert("child-thread".to_owned());
            }
            executor.save_state().unwrap();
            let before = executor.state.clone();
            let bytes = fs::read(executor.state_path()).unwrap();
            let next = prepare_contract_identity(if variation == "same_run" {
                "run-A"
            } else {
                "run-B"
            });
            payload["paperclipNextAuthority"] = json!({"identity": next});
            payload["provider"]["instructions"] = json!("Assigned skill edited v2");
            if variation == "model" {
                payload["provider"]["model"] = json!("foreign-model");
            }
            let result = executor.attach_run(&payload);
            if variation == "new_run" {
                result.unwrap();
                let state = executor.state.as_ref().unwrap();
                assert_eq!(
                    state.config.instructions.as_str(),
                    "Assigned skill edited v2"
                );
                assert_eq!(state.thread_id, before.as_ref().unwrap().thread_id);
                assert_eq!(state.run_identity.as_ref().unwrap().run_id, "run-B");
            } else {
                assert!(result.is_err(), "{variation}");
                assert_eq!(executor.state, before, "{variation}");
                assert_eq!(
                    fs::read(executor.state_path()).unwrap(),
                    bytes,
                    "{variation}"
                );
            }
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn instruction_edit_does_not_manufacture_settlement() {
        for provider in ["codex", "pi_rpc"] {
            for blocker in [
                "active_turn",
                "ambiguous_turn",
                "pending_tool",
                "descendant",
                "deferred_terminal",
            ] {
                let (directory, mut executor, mut payload) =
                    prepared_skill_checkpoint(provider, true);
                let state = executor.state.as_mut().unwrap();
                state.run_identity = Some(prepare_contract_identity("run-A"));
                match blocker {
                    "active_turn" => {
                        state.active_provider_turn_id = Some("old-turn".to_owned());
                        state.lifecycle = "turn_active".to_owned();
                    }
                    "ambiguous_turn" => state.ambiguous_turn_start_pending = true,
                    "pending_tool" => {
                        state.tool_bridge =
                            tool_result_authority_state(provider, "get_task_context").tool_bridge;
                        state
                            .tool_bridge
                            .begin_call(
                                "pending-call".to_owned(),
                                "get_task_context".to_owned(),
                                json!({}),
                            )
                            .unwrap();
                    }
                    "descendant" => {
                        state
                            .descendant_thread_ids
                            .insert("child-thread".to_owned());
                    }
                    "deferred_terminal" => {
                        state.pi_deferred_terminal = Some("turn.completed".to_owned())
                    }
                    _ => unreachable!(),
                }
                executor.event_identity = Some(prepare_contract_identity("run-B"));
                // Deliberately retain an in-memory preexisting state. The guard
                // must not erase it or write a replacement checkpoint.
                let before = executor.state.clone();
                let bytes = fs::read(executor.state_path()).unwrap();
                payload["provider"]["instructions"] = json!("Edited assigned skill v2");
                assert!(executor.prepare(&payload).is_err(), "{provider}: {blocker}");
                assert_eq!(executor.state, before, "{provider}: {blocker}");
                assert_eq!(
                    fs::read(executor.state_path()).unwrap(),
                    bytes,
                    "{provider}: {blocker}"
                );
                fs::remove_dir_all(directory).unwrap();
            }
        }
    }
}
