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

    // Keep: SMAA-1913, seed fffcc200 -> refused c33929b6 after a company
    // skill PATCH and another comment. The issue never closed or reopened:
    // its criterion stays the same, but every new comment advances revision.
    #[test]
    #[cfg(unix)]
    fn open_issue_skill_change_then_comment_prepares_cold_and_answers() {
        open_issue_comment_prepares_cold_and_answers(true, false);
    }

    // Keep: the same production failure after idle expiry/server restart loses
    // the warm entry. A contract-only comment must not require a skill change.
    #[test]
    #[cfg(unix)]
    fn open_issue_warm_entry_lost_then_comment_prepares_cold_and_answers() {
        open_issue_comment_prepares_cold_and_answers(false, false);
    }

    // Keep: C8 has the same durable session, but no saved runIdentity. Public
    // run.prepare must attach it under the authenticated new run's authority.
    #[test]
    #[cfg(unix)]
    fn open_issue_warm_entry_lost_then_comment_prepares_cold_and_answers_from_c8_ownerless_state() {
        open_issue_comment_prepares_cold_and_answers(false, true);
    }

    #[cfg(unix)]
    fn open_issue_comment_command(seq: u64, command_type: &str, payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: format!("open-issue-{seq}"),
            controller_seq: seq,
            command_type: command_type.to_owned(),
            issued_at: "2026-11-14T00:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }

    #[cfg(unix)]
    fn complete_open_issue_turn(executor: &mut CodexCommandExecutor, turn: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut observed = Vec::new();
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "Pi turn {turn}: {observed:?}"
            );
            let events = executor.poll_events().unwrap();
            let count = events.len();
            observed.extend(events);
            executor.acknowledge_events(count).unwrap();
            if observed
                .iter()
                .any(|event| event.event_type == "turn.completed")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            observed.iter().any(|event| {
                event.event_type == "run.result.proposed"
                    && event.payload["summary"]
                        == format!("Answered turn {turn} on the still-open issue.")
                    && event.payload["completionClaim"]["objectiveSatisfied"] == true
            }),
            "a completed local Pi turn must deliver its actual answer: {observed:?}"
        );
        assert!(
            observed.iter().any(|event| {
                event.event_type == "run.terminal"
                    && event.payload["runTerminalState"] == "succeeded"
            }),
            "Pi must report successful completion, not merely accept turn/start: {observed:?}"
        );
        let state = executor.state.as_ref().unwrap();
        assert!(state.active_provider_turn_id.is_none());
        assert!(state.completed_turn_authoritative);
        assert!(state.is_settled_for_run_rebinding());
    }

    #[cfg(unix)]
    fn open_issue_comment_prepares_cold_and_answers(skills_changed: bool, ownerless: bool) {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-open-issue-comment-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let requests = directory.join("pi-requests.jsonl");
        let proxy = directory.join("proxy.sh");
        // Use the qualified local Pi facade pattern from the existing process
        // tests. Persist turn IDs across child restarts and emit real terminal
        // frames plus answer text; this is not a live-model qualification.
        fs::write(&proxy, format!(r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=${{line#*\"id\":}}; id=${{id%%,*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"open-issue-thread","sessionId":"saved-pi-session"}}}}}}\n' "$id" ;;
    *'"method":"thread/read"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"open-issue-thread","status":{{"type":"idle"}},"turns":[]}}}}}}\n' "$id" ;;
    *'"method":"thread/goal/get"'*) printf '{{"id":%s,"result":{{"goal":null}}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      turn=0
      if [ -f '{}' ]; then read -r turn < '{}'; fi
      turn=$((turn + 1))
      printf '%s\n' "$turn" > '{}'
      printf '{{"id":%s,"result":{{"turn":{{"id":"provider-turn-%s"}}}}}}\n' "$id" "$turn"
      printf '{{"method":"turn/started","params":{{"threadId":"open-issue-thread","turn":{{"id":"provider-turn-%s","status":"inProgress"}}}}}}\n' "$turn"
      printf '{{"method":"item/completed","params":{{"threadId":"open-issue-thread","turnId":"provider-turn-%s","item":{{"id":"answer-%s","type":"agentMessage","text":"Answered turn %s on the still-open issue."}}}}}}\n' "$turn" "$turn" "$turn"
      printf '{{"method":"turn/completed","params":{{"threadId":"open-issue-thread","turn":{{"id":"provider-turn-%s","status":"completed"}}}}}}\n' "$turn" ;;
    *'"id":'*) printf '{{"id":%s,"result":true}}\n' "$id" ;;
  esac
done
"#, requests.display(), directory.join("turn-count").display(),
            directory.join("turn-count").display(), directory.join("turn-count").display())).unwrap();
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o600)).unwrap();
        let artifact = |path: PathBuf| crate::durable::QualifiedLaunchArtifact {
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path,
        };
        let mut config = opencode_result_state().config;
        config.provider = "pi_rpc".to_owned();
        config.driver = "pi_rpc".to_owned();
        config.provider_version = crate::generated_pi_rpc_profile::PI_RPC_VERSION.to_owned();
        config.profile = Some(
            serde_json::from_str(crate::generated_pi_rpc_profile::PI_RPC_PROFILE_JSON).unwrap(),
        );
        config.command = fs::canonicalize("/bin/sh").unwrap();
        config.args = vec![proxy.to_string_lossy().into_owned()];
        let profile = OpenCodeLaunchProfile {
            command: artifact(config.command.clone()),
            proxy_script: artifact(proxy),
            executable: artifact(fs::canonicalize("/bin/true").unwrap()),
        };
        let context = json!({"skills":[{"name":"company-skill", "digest":"v1"}]});
        let mut payload = json!({
            "provider": config,
            "completionContract": {"revision":"revision-1", "criterionIds":["SMAA-1913"]},
        });
        payload["provider"]["runtimeContext"] = context.clone();
        let mut seed = CodexCommandExecutor::new(&directory);
        seed.pi_launch_profile = Some(profile.clone());
        seed.event_identity = Some(prepare_contract_identity("run-A"));
        seed.execute(&open_issue_comment_command(
            1,
            "run.prepare",
            payload.clone(),
        ))
        .unwrap();
        seed.execute(&open_issue_comment_command(2, "session.open", json!({})))
            .unwrap();
        seed.execute(&open_issue_comment_command(
            3,
            "turn.start",
            json!({"text":"Answer the original task; the issue remains in_progress."}),
        ))
        .unwrap();
        complete_open_issue_turn(&mut seed, 1);
        seed.shutdown().unwrap();
        let state_path = seed.state_path();
        let previous: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(previous["runIdentity"]["runId"], "run-A");
        assert_eq!(
            previous["completionContract"],
            payload["completionContract"]
        );
        drop(seed);
        if ownerless {
            let mut legacy = previous.clone();
            legacy.as_object_mut().unwrap().remove("runIdentity");
            fs::write(&state_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        }
        let seed_payload = payload.clone();
        payload["completionContract"]["revision"] = json!("revision-2");
        if skills_changed {
            payload["provider"]["runtimeContext"]["skills"][0]["digest"] = json!("v2");
        } else {
            let mut only_revision = seed_payload;
            only_revision["completionContract"]["revision"] = json!("revision-2");
            assert_eq!(
                payload, only_revision,
                "lost-warm-entry case changes ONLY the contract revision"
            );
        }
        let mut next = CodexCommandExecutor::new(&directory);
        next.pi_launch_profile = Some(profile);
        next.event_identity = Some(prepare_contract_identity("run-B"));
        assert!(
            next.state.is_none() && next.provider.is_none(),
            "no warm executor survives"
        );
        // This is exactly execute's restore boundary, exposed here to observe
        // whether prepare itself needlessly restarts the restored Pi process.
        next.restore().unwrap();
        let restored_pid = next.provider.as_ref().unwrap().process_id();
        let restored_generation = next.state.as_ref().unwrap().provider_process_generation;
        let outcome = (|| {
            next.execute(&open_issue_comment_command(
                1,
                "run.prepare",
                payload.clone(),
            ))?;
            let adopted: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
            assert_eq!(adopted["runIdentity"]["runId"], "run-B");
            assert_eq!(adopted["completionContract"], payload["completionContract"]);
            assert_eq!(
                adopted["piRuntimeContext"],
                payload["provider"]["runtimeContext"]
            );
            assert_eq!(adopted["threadId"], previous["threadId"]);
            assert_eq!(adopted["providerSessionId"], previous["providerSessionId"]);
            if skills_changed {
                assert!(
                    next.provider.is_none(),
                    "changed startup skills retire the restored process"
                );
                assert!(local_process_definitely_gone(restored_pid, false));
                assert_eq!(adopted["lifecycle"], "prepared");
            } else {
                assert_eq!(
                    next.provider.as_ref().unwrap().process_id(),
                    restored_pid,
                    "a contract-only comment must retain the already-restored Pi process"
                );
                assert_eq!(adopted["lifecycle"], "session_open");
            }
            next.execute(&open_issue_comment_command(2, "session.open", json!({})))?;
            let current_pid = next.provider.as_ref().unwrap().process_id();
            let generation = next.state.as_ref().unwrap().provider_process_generation;
            if skills_changed {
                assert_ne!(current_pid, restored_pid);
                assert_eq!(generation, restored_generation + 1);
            } else {
                assert_eq!(current_pid, restored_pid);
                assert_eq!(
                    generation, restored_generation,
                    "no extra Pi restart for revision-only adoption"
                );
            }
            next.execute(&open_issue_comment_command(
                3,
                "turn.start",
                json!({"text":"Another user comment on the same still-open issue."}),
            ))?;
            complete_open_issue_turn(&mut next, 2);
            let frames = fs::read_to_string(&requests)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            let starts = frames
                .iter()
                .filter(|frame| frame["method"] == "turn/start")
                .collect::<Vec<_>>();
            assert_eq!(
                starts.len(),
                2,
                "both seed and follow-up completed actual local provider turns"
            );
            assert_eq!(
                starts[0]["params"]["paperclipCompletionContract"]["revision"],
                "revision-1"
            );
            assert_eq!(
                starts[1]["params"]["paperclipCompletionContract"],
                payload["completionContract"]
            );
            assert_eq!(
                starts[1]["params"]["runtimeContext"],
                payload["provider"]["runtimeContext"]
            );
            assert_eq!(starts[1]["params"]["paperclipRunId"], "run-B");
            assert_eq!(starts[1]["params"]["threadId"], previous["threadId"]);
            let resumes = frames
                .iter()
                .filter(|frame| frame["method"] == "thread/resume")
                .count();
            assert_eq!(
                resumes,
                if skills_changed { 2 } else { 1 },
                "server recovery resumes once; only changed startup skills need another resume"
            );
            Ok::<(), DurableRunnerError>(())
        })();
        let shutdown = next.shutdown();
        fs::remove_dir_all(directory).unwrap();
        shutdown.unwrap();
        outcome
            .expect("a new comment on a still-open issue must prepare cold and deliver an answer");
    }
}
