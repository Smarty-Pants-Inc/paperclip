// Keep: production C9 b7f8fb05 -> c1ce1edd, reopened done issue plus company skills PATCH.
// Public native executor, qualified Pi facade, real local child process; no live model claim.
#[test]
#[cfg(unix)]
fn pi_reopened_issue_adopts_contract_and_changed_skills() {
    pi_reopened_issue(false);
}

#[test]
#[cfg(unix)]
fn pi_reopened_issue_adopts_contract_and_changed_skills_from_c8_ownerless_state() {
    pi_reopened_issue(true);
}

#[cfg(unix)]
fn pi_reopened_issue(ownerless: bool) {
    let directory = temporary_directory("pi-prod-reopen");
    let mut cfg = opencode_config(&directory);
    let launch = cfg.opencode_launch_profile.as_mut().unwrap();
    let script = launch.proxy_script.path.clone();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&script, format!(
        "#!/bin/sh\nexec '{}' --state-file '{}' --call-log '{}' --request-log '{}' --durable-turn-ids\n",
        env!("CARGO_BIN_EXE_fake-codex-app-server"),
        directory.join("fake-opencode-state.json").display(),
        directory.join("fake-opencode-calls.log").display(),
        directory.join("pi-requests.jsonl").display(),
    )).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o500)).unwrap();
    launch.proxy_script = qualified_artifact(script);
    cfg.pi_launch_profile = cfg.opencode_launch_profile.take();
    let mut payload = pi_rpc_prepare_payload(&directory);
    payload["provider"]["runtimeContext"] = json!({"runId":"run-1", "skills":[{"name":"company-skill", "digest":"v1"}]});
    let mut seed = NativeProviderCommandExecutor::with_runner_config(&directory, &cfg);
    seed.execute(&command(1, "run.prepare", payload.clone())).unwrap();
    let opened = seed.execute(&command(2, "session.open", json!({}))).unwrap();
    seed.execute(&command(3, "turn.start", json!({"text":"Finish the original task."}))).unwrap();
    poll_opencode_until(&mut seed, "turn.completed");
    acknowledge_delivered_events(&mut seed);
    seed.shutdown().unwrap();
    let state_path = directory.join("codex-provider-state.json");
    let mut previous: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert!(previous["activeProviderTurnId"].is_null());
    if ownerless {
        previous.as_object_mut().unwrap().remove("runIdentity");
        fs::write(&state_path, serde_json::to_vec(&previous).unwrap()).unwrap();
    }
    let mut next_cfg = cfg.clone();
    next_cfg.run_id = "run-2".to_owned();
    next_cfg.turn_id = "turn-2".to_owned();
    next_cfg.item_id = "item-2".to_owned();
    payload["completionContract"] = json!({"revision":"revision-2", "criterionIds":["criterion-1", "one-more-thing"]});
    let context = json!({"runId":"run-2", "skills":[{"name":"company-skill", "digest":"v2"}]});
    payload["provider"]["runtimeContext"] = context.clone();
    let mut next = NativeProviderCommandExecutor::with_runner_config(&directory, &next_cfg);
    let outcome = (|| {
        next.execute(&command(1, "run.prepare", payload.clone()))?;
        let adopted: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(adopted["runIdentity"]["runId"], "run-2");
        assert_eq!(adopted["completionContract"], payload["completionContract"]);
        assert_eq!(adopted["piRuntimeContext"], context);
        assert_eq!(adopted["threadId"], previous["threadId"]);
        assert_eq!(adopted["lifecycle"], "prepared", "changed startup skills retire the restored predecessor process");
        let reopened = next.execute(&command(2, "session.open", json!({})))?;
        assert_ne!(reopened.result["processId"], opened.result["processId"]);
        next.execute(&command(3, "turn.start", json!({"text":"One more thing: apply the updated company skill."})))?;
        poll_opencode_until(&mut next, "turn.completed");
        Ok::<(), paperclip_runner_core::durable::DurableRunnerError>(())
    })();
    let shutdown = next.shutdown();
    if let Err(error) = &outcome { eprintln!("reopen failed before cleanup: {error}"); }
    if outcome.is_ok() {
        shutdown.unwrap();
        let frames = fs::read_to_string(directory.join("pi-requests.jsonl")).unwrap().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
        let seed_start = frames.iter().find(|frame| frame["method"] == "thread/start").unwrap();
        assert_eq!(seed_start["params"]["completionContract"], json!({"revision":"revision-1", "criterionIds":["criterion-1"]}));
        let resumed = frames.iter().rev().find(|frame| frame["method"] == "thread/resume").unwrap();
        assert_eq!(resumed["params"]["completionContract"], payload["completionContract"]);
        let turn = frames.iter().rev().find(|frame| frame["method"] == "turn/start").unwrap();
        assert_eq!(turn["params"]["runtimeContext"], context);
        assert_eq!(turn["params"]["paperclipRunId"], "run-2");
        assert_eq!(turn["params"]["paperclipCompletionContract"], payload["completionContract"]);
        assert!(frames.iter().filter(|frame| frame["method"] == "thread/resume").count() >= 2,
            "cold restore and refreshed Pi startup must both resume the retained conversation");
    }
    fs::remove_dir_all(directory).unwrap();
    outcome.expect("reopened Pi issue must adopt revision 2 and changed skills, then complete a real provider turn");
}
