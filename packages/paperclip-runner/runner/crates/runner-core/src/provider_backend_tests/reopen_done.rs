mod reopen_done {
    use super::*;

    // Keep: hq-test run f7453520 (M1 c1dea0db): a satisfied task went DONE,
    // a company skill was added, and a comment reopened it on a resumed box.
    // Exercise actual facade turns, accepted paperclip_finish, durable restore,
    // and the new run's composed instructions, not only runtimeContext bytes.
    #[test]
    #[cfg(unix)]
    fn done_skill_added_reopened_on_resumed_box_answers() {
        reopened_done_answers(true, true, false, true);
    }

    #[test]
    #[cfg(unix)]
    fn done_reopened_on_resumed_box_without_skill_change_answers() {
        reopened_done_answers(false, true, false, true);
    }

    #[test]
    #[cfg(unix)]
    fn done_skill_added_reopened_without_executor_restart_answers() {
        reopened_done_answers(true, false, false, true);
    }

    // Probe composed-instruction changes separately from the skill-only shape.
    #[test]
    #[cfg(unix)]
    fn done_skill_and_instructions_reopened_on_resumed_box_answers() {
        reopened_done_answers(true, true, true, false);
    }

    #[test]
    #[cfg(unix)]
    fn done_skill_added_reopened_after_clean_shutdown_answers() {
        reopened_done_answers(true, true, false, false);
    }

    #[test]
    #[cfg(unix)]
    fn done_reopened_after_clean_shutdown_without_skill_change_answers() {
        reopened_done_answers(false, true, false, false);
    }

    #[test]
    fn reopened_done_prepare_keeps_same_run_profile_and_nonidle_event_fences() {
        for blocker in [
            "same_run_contract",
            "same_run_instructions",
            "no_thread_instructions",
            "model",
            "command",
            "args",
            "cwd",
            "permissions",
            "version",
            "profile",
            "session",
            "driver",
            "nonidle_previous",
            "nonidle_active",
            "missing_previous",
        ] {
            let (directory, mut executor, mut payload) = prepared_skill_checkpoint("pi_rpc", true);
            executor.state.as_mut().unwrap().run_identity =
                Some(prepare_contract_identity("run-A"));
            executor.state.as_mut().unwrap().completion_contract =
                Some(CompletionContractBinding {
                    revision: "revision-1".to_owned(),
                    criterion_ids: vec!["criterion-1".to_owned()],
                });
            executor.event_identity = Some(prepare_contract_identity(
                if blocker.starts_with("same_run") {
                    "run-A"
                } else {
                    "run-B"
                },
            ));
            payload["completionContract"] =
                json!({"revision":"revision-2", "criterionIds":["criterion-1"]});
            payload["provider"]["runtimeContext"] =
                json!({"skills":[{"name":"new-company-skill"}]});
            match blocker {
                "same_run_instructions" => {
                    payload["completionContract"] = serde_json::to_value(
                        executor.state.as_ref().unwrap().completion_contract.clone(),
                    )
                    .unwrap();
                    payload["provider"]["instructions"] = json!("Changed run instructions");
                }
                "no_thread_instructions" => {
                    executor.state.as_mut().unwrap().thread_id = None;
                    payload["provider"]["instructions"] = json!("Changed run instructions");
                }
                "model" => payload["provider"]["model"] = json!("other/model"),
                "command" => payload["provider"]["command"] = json!("/bin/false"),
                "args" => payload["provider"]["args"] = json!(["different-launch"]),
                "cwd" => payload["provider"]["cwd"] = json!("/different-workspace"),
                "permissions" => payload["provider"]["externallySandboxed"] = json!(true),
                "version" => payload["provider"]["providerVersion"] = json!("different-release"),
                "profile" => payload["provider"]["profile"]["profileVersion"] = json!(999),
                "session" => payload["provider"]["providerSessionId"] = json!("foreign-thread"),
                "driver" => payload["provider"]["driver"] = json!("codex_app_server"),
                "nonidle_previous" | "nonidle_active" | "missing_previous" => {
                    let mut notice =
                        json!({"previousProviderTurnId":null,"activeProviderTurnId":null});
                    match blocker {
                        "nonidle_previous" => notice["previousProviderTurnId"] = json!("old-turn"),
                        "nonidle_active" => notice["activeProviderTurnId"] = json!("live-turn"),
                        _ => {
                            notice
                                .as_object_mut()
                                .unwrap()
                                .remove("previousProviderTurnId");
                        }
                    }
                    executor
                        .state
                        .as_mut()
                        .unwrap()
                        .push_event(NormalizedProviderEvent {
                            event_type: "session.reconciled".to_owned(),
                            priority: EventPriority::P0,
                            payload: notice,
                        })
                        .unwrap();
                }
                _ => {}
            }
            executor.save_state().unwrap();
            let before = fs::read(executor.state_path()).unwrap();
            let before_state = executor.state.clone();
            assert!(
                executor
                    .prepare_with_legacy_attachment(&payload, true)
                    .is_err(),
                "{blocker}"
            );
            assert_eq!(
                fs::read(executor.state_path()).unwrap(),
                before,
                "{blocker}"
            );
            assert_eq!(executor.state, before_state, "{blocker}");
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn exited_checkpoint_attach_keeps_side_effect_and_process_ownership_fences() {
        for blocker in [
            "generation",
            "descendant",
            "deferred",
            "receipt",
            "startup",
            "tool",
        ] {
            let (directory, mut executor, payload) = prepared_skill_checkpoint("pi_rpc", true);
            let state = executor.state.as_mut().unwrap();
            state.lifecycle = "provider_exited".to_owned();
            match blocker {
                "generation" => state.provider_process_generation = 0,
                "descendant" => {
                    state.descendant_thread_ids.insert("live-child".to_owned());
                }
                "deferred" => state.pi_deferred_terminal = Some("turn.completed".to_owned()),
                "receipt" => state.receipt_limit_interrupt_pending = true,
                "tool" => {
                    state.tool_bridge =
                        tool_result_authority_state("pi_rpc", "get_task_context").tool_bridge;
                    state
                        .tool_bridge
                        .begin_call(
                            "pending".to_owned(),
                            "get_task_context".to_owned(),
                            json!({}),
                        )
                        .unwrap();
                }
                _ => {
                    executor
                        .begin_startup(ProviderStartupTrigger::Restore, 2)
                        .unwrap();
                }
            }
            let before = executor.state.clone();
            let disk = fs::read(executor.state_path()).unwrap();
            assert!(executor.attach_run(&payload).is_err(), "{blocker}");
            assert_eq!(executor.state, before, "{blocker}");
            assert_eq!(fs::read(executor.state_path()).unwrap(), disk, "{blocker}");
            assert!(executor.provider.is_none(), "{blocker}");
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[cfg(unix)]
    fn command(seq: u64, command_type: &str, payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: format!("reopen-done-{seq}"),
            controller_seq: seq,
            command_type: command_type.to_owned(),
            issued_at: "2026-11-14T00:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }

    #[cfg(unix)]
    fn finish_turn(executor: &mut CodexCommandExecutor, turn: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut observed = Vec::new();
        let mut delivered = false;
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "turn {turn}: {observed:?}"
            );
            let events = executor.poll_events().unwrap();
            let finish = events
                .iter()
                .any(|event| event.event_type == "semantic_tool.input");
            let terminal = events
                .iter()
                .any(|event| event.event_type == "run.terminal");
            let count = events.len();
            observed.extend(events);
            executor.acknowledge_events(count).unwrap();
            if finish && !delivered {
                executor
                    .execute(&command(
                        10 + turn,
                        "semantic_tool.result",
                        json!({
                            "callId": format!("finish-{turn}"), "operationId":"paperclip_finish",
                            "isError":false, "result":{"ok":true,"issue":{"status":"done"}},
                        }),
                    ))
                    .unwrap();
                delivered = true;
            }
            if terminal {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            delivered,
            "DONE must follow an accepted completion tool: {observed:?}"
        );
        assert!(
            observed
                .iter()
                .any(|event| event.event_type == "semantic_tool.input"
                    && event.payload["semantic_tool"]["input"]["reportedWorkDisposition"]
                        == "done"
                    && event.payload["semantic_tool"]["input"]["completionClaim"]
                        ["objectiveSatisfied"]
                        == true
                    && event.payload["semantic_tool"]["input"]["completionClaim"]
                        ["contractRevision"]
                        == format!("revision-{turn}")),
            "the accepted tool input must satisfy DONE: {observed:?}"
        );
        assert!(
            observed
                .iter()
                .any(|event| event.event_type == "semantic_tool.result"
                    && event.payload["semantic_tool"]["callId"] == format!("finish-{turn}")
                    && event.payload["semantic_tool"]["outcome"] == "succeeded"),
            "a correlated successful receipt is required: {observed:?}"
        );
        assert!(
            !observed
                .iter()
                .any(|event| event.event_type == "run.result.proposed"),
            "accepted paperclip_finish must suppress the generated fallback: {observed:?}"
        );
        assert!(
            observed
                .iter()
                .any(|event| event.event_type == "run.terminal"
                    && event.payload["runTerminalState"] == "succeeded"
                    && event.payload["reportedWorkDisposition"] == "done"),
            "{observed:?}"
        );
        let state = executor.state.as_ref().unwrap();
        assert!(state.completed_turn_authoritative);
        assert_eq!(
            state.active_provider_result_disposition.as_deref(),
            Some("done")
        );
        assert!(state.active_provider_result_fingerprint.is_some());
        assert!(state.pi_deferred_terminal.is_none());
        assert!(state.descendant_thread_ids.is_empty());
        assert!(state.is_settled_for_run_rebinding());
        eprintln!(
            "DONE turn={turn}: {}",
            json!({
                "lifecycle":state.lifecycle, "runIdentity":state.run_identity,
                "completionContract":state.completion_contract,
                "completedTurnAuthoritative":state.completed_turn_authoritative,
                "activeProviderResultDisposition":state.active_provider_result_disposition,
                "activeProviderResultFingerprint":state.active_provider_result_fingerprint,
                "piDeferredTerminal":state.pi_deferred_terminal, "goal":state.goal,
                "descendantThreadIds":state.descendant_thread_ids,
                "settledResults":serde_json::to_value(&state.tool_bridge).unwrap()["settledResults"],
            })
        );
    }

    #[cfg(unix)]
    fn reopened_done_answers(
        skills_changed: bool,
        restarted: bool,
        instructions_changed: bool,
        provider_exited: bool,
    ) {
        let directory =
            std::env::temp_dir().join(format!("paperclip-reopen-done-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let requests = directory.join("requests.jsonl");
        let proxy = directory.join("proxy.sh");
        for turn in 1..=2 {
            let mut result = valid_opencode_result();
            result["completionClaim"]["contractRevision"] = json!(format!("revision-{turn}"));
            fs::write(
                directory.join(format!("result-{turn}.json")),
                serde_json::to_string(&result).unwrap(),
            )
            .unwrap();
        }
        fs::write(&proxy, format!(r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=${{line#*\"id\":}}; id=${{id%%,*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"done-thread","sessionId":"saved-pi-session"}}}}}}\n' "$id" ;;
    *'"method":"thread/read"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"done-thread","status":{{"type":"idle"}},"turns":[]}}}}}}\n' "$id" ;;
    *'"method":"thread/goal/get"'*) printf '{{"id":%s,"result":{{"goal":null}}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      turn=0
      if [ -f '{dir}/turn-count' ]; then read -r turn < '{dir}/turn-count'; fi
      turn=$((turn + 1)); printf '%s\n' "$turn" > '{dir}/turn-count'
      result=''
      IFS= read -r result < '{dir}/result-'"$turn"'.json' || true
      printf '{{"id":%s,"result":{{"turn":{{"id":"provider-turn-%s"}}}}}}\n' "$id" "$turn"
      printf '{{"method":"turn/started","params":{{"threadId":"done-thread","turn":{{"id":"provider-turn-%s","status":"inProgress"}}}}}}\n' "$turn"
      printf '{{"id":91,"method":"item/tool/call","params":{{"threadId":"done-thread","turnId":"provider-turn-%s","callId":"finish-%s","tool":"paperclip_finish","arguments":%s}}}}\n' "$turn" "$turn" "$result" ;;
    *'"id":91'*)
      printf '{{"method":"turn/completed","params":{{"threadId":"done-thread","turn":{{"id":"provider-turn-%s","status":"completed"}}}}}}\n' "$turn"
      if [ "$turn" = 1 ] && [ '{exit_after_done}' = true ]; then exit 7; fi ;;
    *'"id":'*) printf '{{"id":%s,"result":true}}\n' "$id" ;;
  esac
done
"#, requests.display(), dir=directory.display(), exit_after_done=provider_exited)).unwrap();
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o600)).unwrap();
        let artifact = |path: PathBuf| crate::durable::QualifiedLaunchArtifact {
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path,
        };
        let declared = tool_result_authority_state("pi_rpc", "paperclip_finish");
        let operations = declared
            .tool_bridge
            .authorized_tools()
            .cloned()
            .collect::<Vec<_>>();
        let tools = AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        };
        let mut config = declared.config;
        config.command = fs::canonicalize("/bin/sh").unwrap();
        config.args = vec![proxy.to_string_lossy().into_owned()];
        config.instructions = "Company instructions.\n\nAssigned skills: none.".to_owned();
        let profile = OpenCodeLaunchProfile {
            command: artifact(config.command.clone()),
            proxy_script: artifact(proxy),
            executable: artifact(fs::canonicalize("/bin/true").unwrap()),
        };
        let mut payload = json!({"provider":config, "authorizedTools":tools,
            "completionContract":{"revision":"revision-1","criterionIds":["criterion-1"]}});
        payload["provider"]["runtimeContext"] =
            json!({"skills":[], "prompt":{"text":"Assigned skills: none."}});
        let mut executor = CodexCommandExecutor::new(&directory);
        executor.pi_launch_profile = Some(profile.clone());
        executor.event_identity = Some(prepare_contract_identity("run-A"));
        executor
            .execute(&command(1, "run.prepare", payload.clone()))
            .unwrap();
        executor
            .execute(&command(2, "session.open", json!({})))
            .unwrap();
        executor
            .execute(&command(
                3,
                "turn.start",
                json!({"text":"Complete this issue and report done."}),
            ))
            .unwrap();
        finish_turn(&mut executor, 1);
        if provider_exited {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while executor.provider.is_some() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "completed provider must exit"
                );
                let events = executor.poll_events().unwrap();
                executor.acknowledge_events(events.len()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert_eq!(
                executor.state.as_ref().unwrap().lifecycle,
                "provider_exited"
            );
            assert!(executor
                .state
                .as_ref()
                .unwrap()
                .is_settled_for_run_rebinding());
        }
        let before = executor.state.as_ref().unwrap().clone();
        let state_path = executor.state_path();
        if restarted {
            if !provider_exited {
                executor.shutdown().unwrap();
            }
            drop(executor);
            executor = CodexCommandExecutor::new(&directory);
            executor.pi_launch_profile = Some(profile);
            assert!(executor.state.is_none() && executor.provider.is_none());
        }
        executor.event_identity = Some(prepare_contract_identity("run-B"));
        executor.restore().unwrap();
        payload["completionContract"]["revision"] = json!("revision-2");
        if skills_changed {
            payload["provider"]["runtimeContext"] = json!({"skills":[{"name":"company-skill","digest":"added-v1"}],
                "prompt":{"text":"Assigned skills: company-skill."}});
        }
        if instructions_changed {
            payload["provider"]["instructions"] =
                json!("Company instructions.\n\nAssigned skills: company-skill.");
        }
        let restored = executor.state.as_ref().unwrap();
        let config: CodexProviderConfig =
            serde_json::from_value(payload["provider"].clone()).unwrap();
        let rebind_run = restored.run_identity.as_ref().unwrap().run_id
            != executor.event_identity.as_ref().unwrap().run_id
            && restored.is_settled_for_run_attachment()
            && restored.pi_deferred_terminal.is_none()
            && restored.descendant_thread_ids.is_empty()
            && executor.provider.as_ref().is_none_or(|provider| {
                provider.run_attachment_live_work().is_empty()
                    && !provider.has_active_goal()
                    && !provider.has_known_descendants()
            });
        eprintln!("REOPEN skills_changed={skills_changed} restarted={restarted} instructions_changed={instructions_changed} provider_exited={provider_exited} rebind_run={rebind_run}: config_equal={} instructions_equal={} different_run={} settled_rebinding={} settled_attachment={} deferred_none={} descendants_empty={} provider_live_work={:?} provider_goal={} provider_descendants={} lifecycle={} retained={:?}",
            restored.config == config, restored.config.instructions == config.instructions,
            restored.run_identity.as_ref().unwrap().run_id != executor.event_identity.as_ref().unwrap().run_id,
            restored.is_settled_for_run_rebinding(), restored.is_settled_for_run_attachment(),
            restored.pi_deferred_terminal.is_none(), restored.descendant_thread_ids.is_empty(),
            executor.provider.as_ref().map(CodexProvider::run_attachment_live_work),
            executor.provider.as_ref().is_some_and(CodexProvider::has_active_goal),
            executor.provider.as_ref().is_some_and(CodexProvider::has_known_descendants), restored.lifecycle,
            restored.pending_events.iter().chain(restored.queued_events.iter()).map(|event| &event.event_type).collect::<Vec<_>>());
        let outcome = (|| -> Result<(), DurableRunnerError> {
            executor.execute(&command(20, "run.prepare", payload.clone()))?;
            let adopted: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
            assert_eq!(adopted["runIdentity"]["runId"], "run-B");
            assert_eq!(adopted["completionContract"], payload["completionContract"]);
            assert_eq!(
                adopted["piRuntimeContext"],
                payload["provider"]["runtimeContext"]
            );
            assert_eq!(
                adopted["config"]["instructions"],
                payload["provider"]["instructions"]
            );
            assert_eq!(adopted["threadId"], json!(before.thread_id));
            assert_eq!(
                adopted["providerSessionId"],
                json!(before.provider_session_id)
            );
            assert!(adopted["activeProviderResultFingerprint"].is_null());
            executor.execute(&command(21, "session.open", json!({})))?;
            executor.execute(&command(
                22,
                "turn.start",
                json!({"text":"A new comment reopens the DONE issue. Answer it."}),
            ))?;
            finish_turn(&mut executor, 2);
            let frames = fs::read_to_string(&requests)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            let starts = frames
                .iter()
                .filter(|frame| frame["method"] == "turn/start")
                .collect::<Vec<_>>();
            assert_eq!(starts.len(), 2);
            assert_eq!(
                starts[1]["params"]["paperclipCompletionContract"],
                payload["completionContract"]
            );
            assert_eq!(
                starts[1]["params"]["runtimeContext"],
                payload["provider"]["runtimeContext"]
            );
            assert!(
                starts[1]["params"]["baseInstructions"]
                    .as_str()
                    .unwrap()
                    .starts_with(payload["provider"]["instructions"].as_str().unwrap()),
                "the actual successor turn must receive its own instructions"
            );
            assert_eq!(starts[1]["params"]["paperclipRunId"], "run-B");
            assert_eq!(starts[1]["params"]["threadId"], "done-thread");
            Ok(())
        })();
        let shutdown = executor.shutdown();
        fs::remove_dir_all(directory).unwrap();
        shutdown.unwrap();
        outcome.expect(
            "a reopened finished task must prepare and answer under its new run's contract/context",
        );
    }
}
