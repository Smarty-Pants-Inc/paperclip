mod judge_cutover {
    use super::*;

    // Desired real cutover behavior: C8-shaped state must not require a hidden
    // replay of the previous task before the next issue can start.
    #[test]
    fn old_box_first_new_issue_prepare_must_adopt_new_contract() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        let path = directory.join("codex-provider-state.json");
        let mut old: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("runIdentity");
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        payload["completionContract"] = json!({"revision":"issue-Y", "criterionIds":["issue-Y-rule"]});
        let mut next = CodexCommandExecutor::new(&directory);
        next.event_identity = Some(prepare_contract_identity("run-B"));
        let result = next.execute(&crate::durable::Command {
            schema: "paperclip.prp.command.v1".to_owned(), command_id:"new-issue-prepare".to_owned(),
            controller_seq:1, command_type:"run.prepare".to_owned(), issued_at:"2026-11-14T00:00:00Z".to_owned(),
            deadline_at:None, precondition:None, payload,
        });
        fs::remove_dir_all(directory).unwrap();
        result.expect("first new issue on a C8 box must prepare without replaying the previous issue");
    }

    #[test]
    fn known_pi_new_run_must_refresh_run_scoped_context() {
        let (directory, mut old, mut payload) = prepared_skill_checkpoint("pi_rpc", true);
        old.event_identity = Some(prepare_contract_identity("original-run"));
        old.prepare(&payload).unwrap(); // unchanged prepare establishes the matching prior run owner
        let mut next = CodexCommandExecutor::new(&directory);
        next.pi_launch_profile = old.pi_launch_profile.clone();
        next.event_identity = Some(prepare_contract_identity("run-B"));
        next.load_state_without_provider().unwrap();
        payload["provider"]["runtimeContext"] = json!({"runId":"run-B"});
        payload["completionContract"] = json!({"revision":"issue-Y", "criterionIds":["issue-Y-rule"]});
        let result = next.prepare(&payload);
        fs::remove_dir_all(directory).unwrap();
        result.expect("a known new Pi run must receive its own runtime context through attach, not be refused");
    }

    #[test]
    fn legacy_refusal_repeats_without_binding_an_owner_but_attach_can_rebind() {
        let (directory, mut payload) = prepared_contract_checkpoint();
        let path = directory.join("codex-provider-state.json");
        let mut old: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("runIdentity");
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let before=fs::read(&path).unwrap();
        payload["completionContract"] = json!({"revision":"issue-Y", "criterionIds":["issue-Y-rule"]});
        for _ in 0..3 {
            let mut next=restore_contract_checkpoint(&directory,"run-B");
            let err=next.prepare(&payload).unwrap_err();
            assert!(err.to_string().contains("completion contract changed"));
            assert_eq!(fs::read(&path).unwrap(),before);
            assert!(next.state.as_ref().unwrap().run_identity.is_none());
        }
        let mut next=restore_contract_checkpoint(&directory,"run-B");
        next.attach_run(&payload).expect("ordinary explicit attachment works for settled legacy state");
        assert_eq!(next.state.as_ref().unwrap().run_identity.as_ref().unwrap().run_id,"run-B");
        assert_eq!(next.state.as_ref().unwrap().completion_contract,completion_contract(&payload).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }
}
