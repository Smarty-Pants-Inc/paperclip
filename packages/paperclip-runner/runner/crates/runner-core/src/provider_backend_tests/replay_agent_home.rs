#[cfg(unix)]
mod replay_agent_home {
    use super::*;

    // Keep: recorded cold-reopen refusal on 1630490cc. The native provider
    // selection was unchanged, but composed instructions embedded the old
    // run's AGENT_HOME. The current run's working-copy path changed that
    // CodexProviderConfig field even though the instruction asset was identical.
    // This minimized checkpoint contains no production IDs or instruction text:
    // a bare fixture path stands for the entire opaque composed instruction.
    // Cwd/launch artifacts and their digest are bound to the test's local fake.
    // Existing b80c87cd1 already fixes this predicate; this replay must remain
    // green on 2735d4caf and red on the original installed clause.
    #[test]
    fn cold_prepare_rebinds_run_scoped_pi_agent_home_from_saved_bytes() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-agent-home-replay-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let proxy = directory.join("proxy.sh");
        let requests = directory.join("requests.jsonl");
        fs::write(
            &proxy,
            format!(
                r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=${{line#*\"id\":}}; id=${{id%%,*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"thread/resume"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"fixture-thread","sessionId":"fixture-thread"}}}}}}\n' "$id" ;;
    *'"method":"thread/read"'*)
      printf '{{"id":%s,"result":{{"thread":{{"id":"fixture-thread","status":{{"type":"idle"}},"turns":[]}}}}}}\n' "$id" ;;
    *'"method":"thread/goal/get"'*) printf '{{"id":%s,"result":{{"goal":null}}}}\n' "$id" ;;
    *'"method":"turn/start"'*) printf '{{"id":%s,"result":{{"turn":{{"id":"fixture-next-turn"}}}}}}\n' "$id" ;;
    *'"id":'*) printf '{{"id":%s,"result":true}}\n' "$id" ;;
  esac
done
"#,
                requests.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o600)).unwrap();
        let artifact = |path: PathBuf| crate::durable::QualifiedLaunchArtifact {
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap())),
            path,
        };
        let profile = OpenCodeLaunchProfile {
            command: artifact(fs::canonicalize("/bin/sh").unwrap()),
            proxy_script: artifact(proxy),
            executable: artifact(fs::canonicalize("/bin/true").unwrap()),
        };
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/pi-reopen-agent-home.json")).unwrap();
        let mut saved = fixture["state"].clone();
        saved["config"]["profile"] =
            serde_json::from_str(crate::generated_pi_rpc_profile::PI_RPC_PROFILE_JSON).unwrap();
        saved["config"]["command"] = json!(profile.command.path);
        saved["config"]["args"] = json!([profile.proxy_script.path]);
        saved["config"]["cwd"] = json!(directory);
        let mut state: CodexProviderState = serde_json::from_value(saved).unwrap();
        let mut writer = CodexCommandExecutor::new(&directory);
        writer.pi_launch_profile = Some(profile.clone());
        state.pi_launch_profile_digest = writer.bind_pi_launch_profile(&state.config).unwrap();
        writer.persist_state(&state).unwrap();
        drop(writer);

        let mut identity = state.run_identity.clone().unwrap();
        identity.run_id = "run-B".to_owned();
        identity.turn_id = "turn-run-B".to_owned();
        identity.item_id = "item-run-B".to_owned();
        let mut provider = serde_json::to_value(&state.config).unwrap();
        provider["runtimeContext"] = fixture["successor"]["runtimeContext"].clone();
        provider["instructions"] =
            provider["runtimeContext"]["instructions"]["workingCopy"]["rootPath"].clone();
        let payload = json!({
            "provider": provider,
            "completionContract": fixture["successor"]["completionContract"],
        });
        let mut executor = CodexCommandExecutor::new(&directory);
        executor.pi_launch_profile = Some(profile);
        executor.event_identity = Some(identity.clone());
        executor.restore().unwrap();
        let before = executor.state.as_ref().unwrap();
        assert!(before.is_settled_for_run_attachment());
        assert!(!before.is_settled_for_run_rebinding());
        assert!(before.pi_deferred_terminal.is_none());
        assert!(before.descendant_thread_ids.is_empty());
        let live = executor.provider.as_ref().unwrap();
        assert!(live.run_attachment_live_work().is_empty());
        assert!(!live.has_active_goal());
        assert!(!live.has_known_descendants());
        let mut stable: CodexProviderConfig =
            serde_json::from_value(payload["provider"].clone()).unwrap();
        assert_ne!(before.config.instructions, stable.instructions);
        stable.instructions = before.config.instructions.clone();
        assert_eq!(
            before.config, stable,
            "instructions are the only difference"
        );
        let command = Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: "fixture-prepare".to_owned(),
            controller_seq: 1,
            command_type: "run.prepare".to_owned(),
            issued_at: "2026-11-14T00:00:00Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload: payload.clone(),
        };
        let result = (|| -> Result<(), DurableRunnerError> {
            executor.execute(&command)?;
            let adopted = executor.state.as_ref().unwrap();
            assert_eq!(adopted.run_identity, Some(identity));
            assert_eq!(adopted.completion_contract, completion_contract(&payload)?);
            assert_eq!(adopted.pi_runtime_context, provider["runtimeContext"]);
            assert_eq!(adopted.config.instructions, provider["instructions"]);
            assert_eq!(adopted.thread_id, state.thread_id);
            assert_eq!(adopted.provider_session_id, state.provider_session_id);
            assert!(adopted.active_provider_result_fingerprint.is_none());
            executor.open_session()?;
            executor.start_turn(&json!({"text":"fixture-successor"}))?;
            let frames = fs::read_to_string(&requests)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            assert!(!frames.iter().any(|frame| frame["method"] == "thread/start"));
            let turn = frames
                .iter()
                .find(|frame| frame["method"] == "turn/start")
                .unwrap();
            assert_eq!(turn["params"]["threadId"], "fixture-thread");
            assert_eq!(turn["params"]["paperclipRunId"], "run-B");
            assert_eq!(turn["params"]["runtimeContext"], provider["runtimeContext"]);
            assert_eq!(
                turn["params"]["paperclipCompletionContract"],
                payload["completionContract"]
            );
            assert!(turn["params"]["baseInstructions"]
                .as_str()
                .unwrap()
                .starts_with(provider["instructions"].as_str().unwrap()));
            Ok(())
        })();
        let shutdown = executor.shutdown();
        fs::remove_dir_all(directory).unwrap();
        shutdown.unwrap();
        result.expect(
            "the successor's agent-home path is run-scoped, not a changed provider profile",
        );
    }
}
