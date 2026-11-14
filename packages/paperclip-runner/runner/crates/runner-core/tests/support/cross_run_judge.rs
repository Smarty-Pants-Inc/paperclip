mod judge_cross_issue {
    use super::*;

    fn checkpoint(stopped: bool) -> (PathBuf, DurableRunnerConfig, Value) {
        let directory=temporary_directory(if stopped {"judge-stopped"} else {"judge-settled-open"});
        let cfg=durable_config(&directory);
        let payload=json!({"provider":provider_config(&directory,&["--durable-turn-ids"]),
            "completionContract":{"revision":"issue-A-contract","criterionIds":["issue-A-rule"]}});
        let mut first=CodexCommandExecutor::with_runner_config(&directory,&cfg);
        first.execute(&command("prepare-A",1,"run.prepare",payload.clone())).unwrap();
        first.execute(&command("open-A",2,"session.open",json!({}))).unwrap();
        first.execute(&command("turn-A",3,"turn.start",json!({"text":"Finish issue A"}))).unwrap();
        wait_for_executor_event(&mut first,"turn.completed");
        while !poll_and_ack(&mut first).unwrap().is_empty() {}
        if stopped {
            first.execute(&command("stop-A",4,"turn.stop",json!({}))).unwrap();
            while !poll_and_ack(&mut first).unwrap().is_empty() {}
        }
        first.shutdown().unwrap();
        (directory,cfg,payload)
    }

    fn next_run(cfg:&DurableRunnerConfig)->DurableRunnerConfig {
        let mut next=cfg.clone(); next.run_id="run-2".to_owned(); next.turn_id="turn-2".to_owned(); next.item_id="item-2".to_owned(); next
    }

    #[test]
    fn stopped_known_predecessor_prepares_and_opens_new_issues_contract() {
        let (directory,cfg,mut payload)=checkpoint(true);
        let old:Value=serde_json::from_slice(&fs::read(directory.join("codex-provider-state.json")).unwrap()).unwrap();
        assert_eq!(old["runIdentity"]["runId"],"run-1");
        payload["completionContract"]=json!({"revision":"issue-B-contract","criterionIds":["issue-B-rule"]});
        let mut next=CodexCommandExecutor::with_runner_config(&directory,&next_run(&cfg));
        let result=next.execute(&command("prepare-B",1,"run.prepare",payload));
        if result.is_ok() {
            next.execute(&command("open-B",2,"session.open",json!({}))).unwrap();
            let state:Value=serde_json::from_slice(&fs::read(directory.join("codex-provider-state.json")).unwrap()).unwrap();
            assert_eq!(state["runIdentity"]["runId"],"run-2");
            assert_eq!(state["completionContract"],json!({"revision":"issue-B-contract","criterionIds":["issue-B-rule"]}));
            assert_eq!(state["threadId"],old["threadId"]);
        }
        next.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
        result.expect("new issue B must prepare over the stopped known predecessor");
    }

    #[test]
    fn settled_open_predecessor_prepare_does_not_fail_on_its_own_restore_notice() {
        let (directory,cfg,mut payload)=checkpoint(false);
        payload["completionContract"]=json!({"revision":"issue-B-contract","criterionIds":["issue-B-rule"]});
        let mut next=CodexCommandExecutor::with_runner_config(&directory,&next_run(&cfg));
        let result=next.execute(&command("prepare-B",1,"run.prepare",payload));
        let events=next.retained_events().unwrap();
        eprintln!("retained event types: {:?}",events.iter().map(|e|e.event_type.as_str()).collect::<Vec<_>>());
        next.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
        result.expect("a settled known session should not be refused because prepare itself restored it");
    }

    #[test]
    fn synthetic_secret_assignments_still_mask() {
        for (input,expected) in [
            ("DB_PASSWORD hunter2","DB_PASSWORD [REDACTED]"),
            ("proxyPassword correcthorse","proxyPassword [REDACTED]"),
            ("OPENAI_API_KEY sk-example-not-a-real-key","OPENAI_API_KEY [REDACTED]"),
        ] {
            assert_eq!(paperclip_runner_core::durable::redact_diagnostic_text(input),expected);
        }
    }

    #[test]
    fn live_predecessor_mid_turn_rejects_new_run_even_with_same_contract() {
        let directory=temporary_directory("judge-live-predecessor");
        let cfg=durable_config(&directory);
        let payload=json!({"provider":provider_config(&directory,&["--hold-turn"]),
            "completionContract":{"revision":"same","criterionIds":["same-rule"]}});
        let mut live=CodexCommandExecutor::with_runner_config(&directory,&cfg);
        live.execute(&command("prepare-A",1,"run.prepare",payload.clone())).unwrap();
        live.execute(&command("open-A",2,"session.open",json!({}))).unwrap();
        live.execute(&command("turn-A",3,"turn.start",json!({"text":"Keep issue A running"}))).unwrap();
        while !poll_and_ack(&mut live).unwrap().is_empty() {}
        let path=directory.join("codex-provider-state.json");
        let before=fs::read(&path).unwrap();
        // Simulate the executor being offered the new authenticated run while
        // its predecessor's real provider is still mid-turn, not a timeout flag.
        live.rotate_authority(&next_run(&cfg));
        let result=live.execute(&command("prepare-B",4,"run.prepare",payload));
        assert!(result.is_err(),"live predecessor must reject even equal contracts");
        assert_eq!(fs::read(&path).unwrap(),before);
        live.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}
