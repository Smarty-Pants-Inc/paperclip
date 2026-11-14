mod judge_redgreen {
    use super::*;
    fn prepare_contract_identity(run_id: &str) -> ProviderEventIdentity {
        ProviderEventIdentity {
            runner_instance_id: "contract-runner".to_owned(),
            run_id: run_id.to_owned(),
            normalized_session_id: "contract-session".to_owned(),
            turn_id: format!("turn-{run_id}"),
            item_id: format!("item-{run_id}"),
        }
    }

    fn prepared_contract_checkpoint() -> (PathBuf, Value) {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-prepare-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let mut config = opencode_result_state().config;
        config.provider = "codex".to_owned();
        config.driver = "codex_app_server".to_owned();
        config.command = directory.join("must-not-start-during-prepare");
        config.args = vec!["app-server".to_owned()];
        config.model = None;
        let payload = json!({
            "provider": config,
            "completionContract": {"revision": "contract-X", "criterionIds": ["issue-X"]},
        });
        let mut executor = CodexCommandExecutor::new(&directory);
        executor.event_identity = Some(prepare_contract_identity("run-A"));
        executor
            .prepare(&payload)
            .expect("run A prepares contract X");
        // A stopped provider checkpoint, as retained by turn.stop. Preparation
        // and recovery must not launch this deliberately nonexistent command.
        let state = executor.state.as_mut().unwrap();
        state.thread_id = Some("saved-contract-thread".to_owned());
        state.provider_process_generation = 1;
        executor.save_state().unwrap();
        (directory, payload)
    }

    fn restore_contract_checkpoint(
        directory: &std::path::Path,
        run_id: &str,
    ) -> CodexCommandExecutor {
        let mut executor = CodexCommandExecutor::new(directory);
        executor.event_identity = Some(prepare_contract_identity(run_id));
        executor.load_state_without_provider().unwrap();
        executor
    }

    // Keep: regression for SMAA-1618, where run 3b7e4a2d was refused solely
    // because its issue's contract differed from the preceding settled run.
    #[test]
    fn prepare_new_run_adopts_its_completion_contract_on_a_settled_checkpoint() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        payload["completionContract"] =
            json!({"revision": "contract-Y", "criterionIds": ["issue-Y", "follow-up"]});
        let mut executor = restore_contract_checkpoint(&directory, "run-B");
        executor
            .prepare(&payload)
            .expect("a new run owns its contract, not the previous run's contract");
        let expected = completion_contract(&payload).unwrap();
        let state = executor.state.as_ref().unwrap();
        assert_eq!(state.completion_contract, expected);
        assert_eq!(state.thread_id.as_deref(), Some("saved-contract-thread"));
        assert!(executor.provider.is_none());
        let mut recovered = restore_contract_checkpoint(&directory, "run-B");
        assert_eq!(
            recovered.state.as_ref().unwrap().completion_contract,
            expected
        );
        recovered
            .prepare(&payload)
            .expect("same-run replay is stable");
        payload["completionContract"]["revision"] = json!("contract-Z");
        let before = fs::read(executor.state_path()).unwrap();
        assert!(
            recovered.prepare(&payload).is_err(),
            "run B is now bound to Y"
        );
        assert_eq!(fs::read(executor.state_path()).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prepare_same_run_refuses_a_changed_completion_contract() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        let mut executor = restore_contract_checkpoint(&directory, "run-A");
        let before = fs::read(executor.state_path()).unwrap();
        let before_state = executor.state.clone();
        payload["completionContract"]["revision"] = json!("contract-Y");
        let error = executor
            .prepare(&payload)
            .expect_err("same-run contract is immutable");
        assert!(
            error.to_string().contains("completion contract changed"),
            "{error}"
        );
        assert_eq!(executor.state, before_state);
        assert_eq!(fs::read(executor.state_path()).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prepare_new_run_still_refuses_a_changed_provider_config() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        let mut executor = restore_contract_checkpoint(&directory, "run-B");
        let before_state = executor.state.clone();
        let before = fs::read(executor.state_path()).unwrap();
        payload["provider"]["model"] = json!("different-model");
        payload["completionContract"]["revision"] = json!("contract-Y");
        let error = executor
            .prepare(&payload)
            .expect_err("provider config stays immutable");
        assert!(
            error
                .to_string()
                .contains("provider or completion contract changed"),
            "{error}"
        );
        assert_eq!(executor.state, before_state);
        assert_eq!(fs::read(executor.state_path()).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

}
