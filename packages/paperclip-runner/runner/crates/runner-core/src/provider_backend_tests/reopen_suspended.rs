#[cfg(unix)]
mod reopen_suspended {
    use super::reopen_done::finish_turn;
    use super::*;
    use crate::durable::{suspend_for_provider_test, DurableStateStore};

    // Keep: production M1 c1dea0db, 7c3c4823 -> 66d29c2a: DONE with a
    // satisfied receipt and a still-live provider, then idle drain/suspend,
    // lost warm entry, and cold preparation after skills/instructions changed.
    // Unlike an exited-provider checkpoint, suspended is runnerd's lifecycle;
    // the facade's separately persisted lifecycle must come from real cleanup.
    #[test]
    fn suspended_restarted_context_and_contract_answers() {
        scenario(
            "suspended_restarted_context_and_contract_answers",
            true,
            true,
            None,
        );
    }

    #[test]
    fn suspended_same_process_context_and_contract_answers() {
        scenario(
            "suspended_same_process_context_and_contract_answers",
            false,
            true,
            None,
        );
    }

    #[test]
    fn suspended_restarted_contract_only_answers() {
        scenario(
            "suspended_restarted_contract_only_answers",
            true,
            false,
            None,
        );
    }

    #[test]
    fn suspended_same_run_refuses_changed_contract_and_context() {
        scenario(
            "suspended_same_run_refuses_changed_contract_and_context",
            true,
            true,
            Some("same-run"),
        );
    }

    #[test]
    fn live_predecessor_mid_turn_refuses_changed_contract_and_context() {
        scenario(
            "live_predecessor_mid_turn_refuses_changed_contract_and_context",
            false,
            true,
            Some("live-turn"),
        );
    }

    #[test]
    fn suspended_provider_profile_change_refuses() {
        scenario(
            "suspended_provider_profile_change_refuses",
            true,
            true,
            Some("profile"),
        );
    }

    #[test]
    fn suspended_checkpoint_without_process_keeps_settlement_fences() {
        for blocker in [
            "generation",
            "descendant",
            "deferred",
            "receipt",
            "startup",
            "tool",
            "goal",
        ] {
            let (directory, mut executor, payload) = prepared_skill_checkpoint("pi_rpc", true);
            let state = executor.state.as_mut().unwrap();
            state.lifecycle = "session_open".to_owned();
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
                "goal" => {
                    state.goal = normalize_codex_goal(
                        &json!({"objective":"Keep working","status":"active"}),
                        true,
                    )
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

    fn command(seq: u64, kind: &str, payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: format!("reopen-suspended-{seq}"),
            controller_seq: seq,
            command_type: kind.to_owned(),
            issued_at: "2026-11-14T00:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }

    fn launch_profile(directory: &std::path::Path) -> OpenCodeLaunchProfile {
        let artifact = |path: PathBuf| crate::durable::QualifiedLaunchArtifact {
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path,
        };
        OpenCodeLaunchProfile {
            command: artifact(fs::canonicalize("/bin/sh").unwrap()),
            proxy_script: artifact(directory.join("proxy.sh")),
            executable: artifact(fs::canonicalize("/bin/true").unwrap()),
        }
    }

    fn runner_config(directory: &std::path::Path) -> DurableRunnerConfig {
        let identity = prepare_contract_identity("run-A");
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:3000/path".to_owned(),
            ca_bundle_path: None,
            state_dir: directory.join("runner"),
            runner_instance_id: identity.runner_instance_id,
            environment_lease_id: "environment-1".to_owned(),
            run_id: identity.run_id,
            normalized_session_id: identity.normalized_session_id,
            turn_id: identity.turn_id,
            item_id: identity.item_id,
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            acpx_launch_profile: None,
            pi_launch_profile: Some(launch_profile(directory)),
            opencode_launch_profile: None,
            cursor_cloud_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: std::time::Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: std::time::Duration::from_secs(10),
            turn_scoped: false,
        }
    }

    struct Fixture {
        directory: PathBuf,
        executor: CodexCommandExecutor,
        payload: Value,
        owned: bool,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-reopen-suspended-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&directory).unwrap();
            for turn in 1..=2 {
                let mut result = valid_opencode_result();
                result["completionClaim"]["contractRevision"] = json!(format!("revision-{turn}"));
                fs::write(
                    directory.join(format!("result-{turn}.json")),
                    serde_json::to_vec(&result).unwrap(),
                )
                .unwrap();
            }
            let proxy = directory.join("proxy.sh");
            fs::write(&proxy, format!(r#"
printf '%s\n' "$$" >> '{dir}/processes'
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{dir}/requests.jsonl'
  id=${{line#*\"id\":}}; id=${{id%%,*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"suspended-thread","sessionId":"saved-pi-session"}}}}}}\n' "$id" ;;
    *'"method":"thread/read"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"suspended-thread","status":{{"type":"idle"}},"turns":[]}}}}}}\n' "$id" ;;
    *'"method":"thread/goal/get"'*) printf '{{"id":%s,"result":{{"goal":null}}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      turn=0
      if [ -f '{dir}/turn-count' ]; then read -r turn < '{dir}/turn-count'; fi
      turn=$((turn + 1)); printf '%s\n' "$turn" > '{dir}/turn-count'
      result=''
      IFS= read -r result < '{dir}/result-'"$turn"'.json' || true
      printf '{{"id":%s,"result":{{"turn":{{"id":"provider-turn-%s"}}}}}}\n' "$id" "$turn"
      printf '{{"method":"turn/started","params":{{"threadId":"suspended-thread","turn":{{"id":"provider-turn-%s","status":"inProgress"}}}}}}\n' "$turn"
      if [ ! -f '{dir}/hold-turn' ]; then
        printf '{{"id":91,"method":"item/tool/call","params":{{"threadId":"suspended-thread","turnId":"provider-turn-%s","callId":"finish-%s","tool":"paperclip_finish","arguments":%s}}}}\n' "$turn" "$turn" "$result"
      fi ;;
    *'"id":91'*)
      printf '{{"method":"turn/completed","params":{{"threadId":"suspended-thread","turn":{{"id":"provider-turn-%s","status":"completed"}}}}}}\n' "$turn" ;;
    *'"id":'*) printf '{{"id":%s,"result":true}}\n' "$id" ;;
  esac
done
"#, dir=directory.display())).unwrap();
            fs::set_permissions(&proxy, fs::Permissions::from_mode(0o600)).unwrap();
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
            let mut payload = json!({"provider":config,"authorizedTools":tools,
                "completionContract":{"revision":"revision-1","criterionIds":["criterion-1"]}});
            payload["provider"]["runtimeContext"] = json!({"skills":[],
                "instructions":{"entryPath":"AGENTS.md","bundle":{"digest":"instructions-v1"}},"aggregateDigest":"aggregate-v1",
                "prompt":{"text":"Assigned skills: none."}});
            fs::write(
                directory.join("prepare.json"),
                serde_json::to_vec(&payload).unwrap(),
            )
            .unwrap();
            let executor = CodexCommandExecutor::with_runner_config(
                directory.join("provider"),
                &runner_config(&directory),
            );
            Self {
                directory,
                executor,
                payload,
                owned: true,
            }
        }

        fn restored(directory: PathBuf, same_run: bool) -> Self {
            let payload =
                serde_json::from_slice(&fs::read(directory.join("prepare.json")).unwrap()).unwrap();
            let config = runner_config(&directory);
            let store = DurableStateStore::new(&config.state_dir).unwrap();
            let (saved, recovered) = store.load_or_create(&config).unwrap();
            assert!(recovered);
            assert_eq!(saved.lifecycle, "suspended");
            assert!(saved.pending_terminal_delivery.is_none());
            assert!(saved.pending_provider_cleanup.is_none());
            let mut executor =
                CodexCommandExecutor::with_runner_config(directory.join("provider"), &config);
            assert!(executor.state.is_none() && executor.provider.is_none());
            executor.observe_recovery_state(&saved);
            executor.event_identity = Some(prepare_contract_identity(if same_run {
                "run-A"
            } else {
                "run-B"
            }));
            executor.restore().unwrap();
            eprintln!(
                "RESTORED runnerPid={} runnerLifecycle={} providerLifecycle={} providerPresent={}",
                std::process::id(),
                saved.lifecycle,
                executor.state.as_ref().unwrap().lifecycle,
                executor.provider.is_some()
            );
            Self {
                directory,
                executor,
                payload,
                owned: false,
            }
        }

        fn evidence(&self, name: &str, stage: &str) {
            let state = self.executor.state.as_ref().unwrap();
            eprintln!(
                "SUSPENDED {name} {stage}: {}",
                json!({
                    "runnerPid":std::process::id(), "providerLifecycle":state.lifecycle,
                    "runIdentity":state.run_identity, "completionContract":state.completion_contract,
                    "runtimeContext":state.pi_runtime_context, "threadId":state.thread_id,
                    "providerSessionId":state.provider_session_id,
                    "providerProcessGeneration":state.provider_process_generation,
                    "completedTurnAuthoritative":state.completed_turn_authoritative,
                    "activeProviderResultDisposition":state.active_provider_result_disposition,
                    "activeProviderResultFingerprint":state.active_provider_result_fingerprint,
                })
            );
            if let Some(out) = std::env::var_os("PAPERCLIP_REOPEN_SUSPENDED_EVIDENCE") {
                let out = PathBuf::from(out).join(name);
                fs::create_dir_all(&out).unwrap();
                fs::copy(
                    self.executor.state_path(),
                    out.join(format!("{stage}-provider.json")),
                )
                .unwrap();
                for file in ["requests.jsonl", "processes"] {
                    fs::copy(self.directory.join(file), out.join(file)).unwrap();
                }
                let runner = self.directory.join("runner/runner-state.json");
                if runner.exists() {
                    fs::copy(runner, out.join(format!("{stage}-runner.json"))).unwrap();
                }
            }
        }

        fn seed(&mut self, name: &str, suspend: bool) {
            self.executor
                .execute(&command(1, "run.prepare", self.payload.clone()))
                .unwrap();
            self.executor
                .execute(&command(2, "session.open", json!({})))
                .unwrap();
            self.executor
                .execute(&command(
                    3,
                    "turn.start",
                    json!({"text":"Complete this issue and report done."}),
                ))
                .unwrap();
            finish_turn(&mut self.executor, 1);
            assert!(
                self.executor.provider.is_some(),
                "DONE must precede provider shutdown"
            );
            assert_eq!(
                self.executor.state.as_ref().unwrap().lifecycle,
                "session_open"
            );
            self.evidence(name, "done-provider-alive");
            if suspend {
                let config = runner_config(&self.directory);
                config.validate().unwrap();
                let state = suspend_for_provider_test(&config, &mut self.executor).unwrap();
                assert_eq!(state.lifecycle, "suspended");
                assert!(
                    self.executor.provider.is_none(),
                    "runnerd's post-ACK cleanup must stop its provider"
                );
                let provider = self.executor.state.as_ref().unwrap();
                assert_eq!(
                    provider.active_provider_result_disposition.as_deref(),
                    Some("done")
                );
                assert!(provider.active_provider_result_fingerprint.is_some());
                assert!(provider.completed_turn_authoritative);
                eprintln!(
                    "SUSPEND runnerPid={} runnerLifecycle={} providerLifecycle={}",
                    std::process::id(),
                    state.lifecycle,
                    provider.lifecycle
                );
                self.evidence(name, "suspended");
            }
        }

        fn prepare_successor(&mut self, name: &str, context_changed: bool, control: Option<&str>) {
            let before = self.executor.state.as_ref().unwrap().clone();
            self.executor.event_identity =
                Some(prepare_contract_identity(if control == Some("same-run") {
                    "run-A"
                } else {
                    "run-B"
                }));
            self.payload["completionContract"]["revision"] = json!("revision-2");
            if context_changed {
                self.payload["provider"]["runtimeContext"] = json!({"skills":[{"name":"company-skill","digest":"skill-v2"}],
                    "instructions":{"entryPath":"AGENTS.md","bundle":{"digest":"instructions-v2"}},"aggregateDigest":"aggregate-v2",
                    "prompt":{"text":"Assigned skills: company-skill."}});
                // Production's provider config was byte-identical: skills,
                // instruction bindings and aggregate digest changed only in
                // runtimeContext, not in the stable provider profile.
            }
            if control == Some("profile") {
                self.payload["provider"]["model"] = json!("different/model");
            }
            if control != Some("profile") {
                let stable: CodexProviderConfig =
                    serde_json::from_value(self.payload["provider"].clone()).unwrap();
                assert_eq!(
                    before.config, stable,
                    "production keeps the provider profile identical"
                );
            }
            let disk_before = fs::read(self.executor.state_path()).unwrap();
            let generation = before.provider_process_generation;
            eprintln!("PREPARE {name}: differentRun={} settledAttachment={} lifecycle={} providerPresent={} pending={:?}",
                before.run_identity.as_ref().unwrap().run_id != self.executor.event_identity.as_ref().unwrap().run_id,
                before.is_settled_for_run_attachment(), before.lifecycle, self.executor.provider.is_some(),
                before.pending_events.iter().map(|event| &event.event_type).collect::<Vec<_>>());
            let outcome = self
                .executor
                .execute(&command(20, "run.prepare", self.payload.clone()));
            if let Some(control) = control {
                let error = outcome
                    .expect_err("immutable same-run/live-work/provider-profile fences must refuse");
                eprintln!("REFUSED {name} control={control}: {error}");
                assert!(
                    error
                        .to_string()
                        .contains("provider or completion contract changed"),
                    "{error}"
                );
                assert_eq!(self.executor.state.as_ref().unwrap(), &before);
                assert_eq!(fs::read(self.executor.state_path()).unwrap(), disk_before);
                self.evidence(name, "refused");
                return;
            }
            if let Err(error) = &outcome {
                eprintln!("REFUSED {name}: {error}");
                self.evidence(name, "failed-prepare");
            }
            outcome.expect("a different run must prepare over the settled suspended predecessor");
            let adopted = self.executor.state.as_ref().unwrap();
            assert_eq!(adopted.run_identity.as_ref().unwrap().run_id, "run-B");
            assert_eq!(
                serde_json::to_value(&adopted.completion_contract).unwrap(),
                self.payload["completionContract"]
            );
            assert_eq!(
                adopted.pi_runtime_context,
                self.payload["provider"]["runtimeContext"]
            );
            assert_eq!(
                adopted.config.instructions,
                self.payload["provider"]["instructions"].as_str().unwrap()
            );
            assert_eq!(adopted.thread_id, before.thread_id);
            assert_eq!(adopted.provider_session_id, before.provider_session_id);
            assert!(adopted.active_provider_result_fingerprint.is_none());
            self.executor
                .execute(&command(21, "session.open", json!({})))
                .unwrap();
            self.executor
                .execute(&command(
                    22,
                    "turn.start",
                    json!({"text":"A new comment reopens the DONE issue. Answer it."}),
                ))
                .unwrap();
            finish_turn(&mut self.executor, 2);
            let frames = fs::read_to_string(self.directory.join("requests.jsonl"))
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
                self.payload["completionContract"]
            );
            assert_eq!(
                starts[1]["params"]["runtimeContext"],
                self.payload["provider"]["runtimeContext"]
            );
            assert!(starts[1]["params"]["baseInstructions"]
                .as_str()
                .unwrap()
                .starts_with(self.payload["provider"]["instructions"].as_str().unwrap()));
            assert_eq!(starts[1]["params"]["paperclipRunId"], "run-B");
            assert_eq!(starts[1]["params"]["threadId"], "suspended-thread");
            let resumes = frames
                .iter()
                .filter(|frame| frame["method"] == "thread/resume")
                .collect::<Vec<_>>();
            assert!(
                !resumes.is_empty(),
                "successor must resume the saved Pi session, not start a replacement thread"
            );
            assert_eq!(
                resumes.last().unwrap()["params"]["threadId"],
                "suspended-thread"
            );
            let successor_generation = self
                .executor
                .state
                .as_ref()
                .unwrap()
                .provider_process_generation;
            assert!(
                successor_generation > 1,
                "the suspended provider process must be relaunched from its saved session"
            );
            if context_changed {
                assert!(
                    successor_generation > generation,
                    "changed Pi startup context requires a refreshed process"
                );
            }
            self.evidence(name, "successor-done");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let shutdown = self.executor.shutdown();
            if self.owned {
                let cleanup = fs::remove_dir_all(&self.directory);
                if !std::thread::panicking() {
                    cleanup.unwrap();
                }
            }
            if !std::thread::panicking() {
                shutdown.unwrap();
            }
        }
    }

    fn scenario(name: &str, restarted: bool, context_changed: bool, control: Option<&str>) {
        const CHILD_ROOT: &str = "PAPERCLIP_REOPEN_SUSPENDED_CHILD_ROOT";
        if let Some(directory) = std::env::var_os(CHILD_ROOT) {
            let mut fixture =
                Fixture::restored(PathBuf::from(directory), control == Some("same-run"));
            fixture.prepare_successor(name, context_changed, control);
            return;
        }
        let mut fixture = Fixture::new();
        fixture.seed(name, control != Some("live-turn"));
        if control == Some("live-turn") {
            fs::write(fixture.directory.join("hold-turn"), b"hold").unwrap();
            fixture
                .executor
                .execute(&command(
                    12,
                    "turn.start",
                    json!({"text":"Keep working on the predecessor."}),
                ))
                .unwrap();
            let events = fixture.executor.poll_events().unwrap();
            fixture.executor.acknowledge_events(events.len()).unwrap();
            assert!(fixture.executor.provider.is_some());
            assert!(fixture
                .executor
                .state
                .as_ref()
                .unwrap()
                .active_provider_turn_id
                .is_some());
        }
        if restarted {
            let test = format!("provider_backend::tests::reopen_suspended::{name}");
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &test, "--nocapture", "--test-threads=1"])
                .env(CHILD_ROOT, &fixture.directory)
                .output()
                .unwrap();
            eprintln!(
                "PROCESS RESTART {name}: parentPid={} childStatus={}\n{}\n{}",
                std::process::id(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                output.status.success(),
                "successor runner process must satisfy this scenario"
            );
        } else {
            fixture.prepare_successor(name, context_changed, control);
        }
    }
}
