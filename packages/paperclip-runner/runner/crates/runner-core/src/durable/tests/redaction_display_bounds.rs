#[test]
fn provider_transcript_text_survives_projection_and_durable_storage() {
    let mut config = config(PathBuf::from("unused"));
    config.max_frame_bytes = 1024 * 1024;
    config.max_outbox_bytes = 4 * 1024 * 1024;
    for (kind, size) in [
        ("reasoning", 15_435),
        ("agentMessage", 70_000),
        ("agentMessage", 300_000),
    ] {
        let body: String = "word ".repeat(size / 5 + 1).chars().take(size).collect();
        assert_eq!(body.chars().count(), size);
        for (field, value) in [("text", json!(body)), ("summary", json!([{"text": body}]))] {
            if field == "summary" && kind != "reasoning" {
                continue;
            }
            let mut item = json!({"id":"text-item", "type":kind, "phase":"final_answer"});
            item[field] = value;
            let projected = crate::provider_events::normalize_codex_notification(
                "item/completed",
                &json!({"item":item}),
            );
            let event = projected
                .iter()
                .find(|event| event.event_type == "item.completed")
                .unwrap();
            let mut state = DurableState::new(&config);
            state
                .enqueue_event(
                    &config,
                    &event.event_type,
                    event.priority,
                    event.payload.clone(),
                )
                .unwrap();
            assert_eq!(
                state.outbox[0]
                    .envelope
                    .pointer("/payload/payload/text")
                    .and_then(Value::as_str),
                Some(body.as_str()),
                "{kind} {field} {size}"
            );
        }
        let secret = format!("{body} token=do-not-store");
        let projected = crate::provider_events::normalize_codex_notification(
            "item/completed",
            &json!({"item":{
                "id":"secret-item", "type":kind, "phase":"final_answer", "text":secret
            }}),
        );
        let event = projected
            .iter()
            .find(|event| event.event_type == "item.completed")
            .unwrap();
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                &event.event_type,
                event.priority,
                event.payload.clone(),
            )
            .unwrap();
        let saved = state.outbox[0]
            .envelope
            .pointer("/payload/payload/text")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(saved, format!("{body} token=[REDACTED]"));
        assert!(!saved.contains("do-not-store"));
    }
}

#[test]
fn over_frame_transcript_is_a_durable_failure_marker_not_a_final_preview() {
    let mut config = config(PathBuf::from("unused"));
    config.max_frame_bytes = 1024 * 1024;
    config.max_outbox_bytes = 4 * 1024 * 1024;
    let body = "word ".repeat(120_000);
    let mut state = DurableState::new(&config);
    state.enqueue_event(&config, "item.completed", EventPriority::P1,
        json!({"kind":"agentMessage", "channel":"final", "text":body, "answers":["question-1"]}))
        .unwrap();
    let saved = state.outbox[0].envelope.pointer("/payload/payload").unwrap();
    assert_eq!(saved["transcriptOverflow"], true);
    assert_eq!(saved["truncated"], true);
    assert_eq!(saved["channel"], "detail");
    assert!(saved.get("answers").is_none());
    assert!(saved["text"].as_str().unwrap().contains("no complete answer was saved"));
    assert!(!saved["text"].as_str().unwrap().contains("word "));
}

#[test]
fn transcript_deltas_and_started_items_are_not_diagnostic_previews() {
    let mut config = config(PathBuf::from("unused"));
    config.max_frame_bytes = 1024 * 1024;
    config.max_outbox_bytes = 1024 * 1024;
    let body = "word ".repeat(3_087);
    for kind in ["reasoning", "agentMessage", "assistant_message"] {
        for event_type in [
            "item.started",
            "item.updated",
            "item.delta",
            "item.completed",
        ] {
            let mut state = DurableState::new(&config);
            state
                .enqueue_event(
                    &config,
                    event_type,
                    EventPriority::P2,
                    json!({"kind":kind, "text":body}),
                )
                .unwrap();
            assert_eq!(
                state.outbox[0]
                    .envelope
                    .pointer("/payload/payload/text")
                    .and_then(Value::as_str),
                Some(body.as_str()),
                "{kind} {event_type}"
            );
        }
    }
}

#[test]
fn redaction_growth_keeps_a_full_tool_output_inside_its_schema_bound() {
    let mut config = config(PathBuf::from("unused"));
    config.max_outbox_bytes = 1024 * 1024;
    config.max_frame_bytes = 256 * 1024;
    for (needle, secret) in [
        ("GITHUB_TOKEN: ***", "***"),
        ("token=abc", "token=abc"),
        ("Authorization: Bearer x", "Bearer x"),
        ("password: hunter2", "hunter2"),
    ] {
        let mut state = DurableState::new(&config);
        let line = format!("{}\n{needle}\n", "x".repeat(70));
        let text: String = line
            .repeat(65_536 / line.len() + 1)
            .chars()
            .take(65_536)
            .collect();
        state
            .enqueue_event(&config, "tool.execution.completed", EventPriority::P1, json!({
                "schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"execute","status":"completed",
                "output":text,"outputBytes":200_000,"outputTruncated":false,"outputDigest":format!("sha256:{}", "a".repeat(64))
            }))
            .unwrap_or_else(|error| panic!("{needle} was rejected: {error:?}"));
        let stored = state.outbox[0]
            .envelope
            .pointer("/payload/payload")
            .unwrap();
        let output = stored["output"].as_str().unwrap();
        let redacted = redact_sensitive_text_values(&text);
        let expected: String = redacted
            .chars()
            .skip(redacted.chars().count() - 65_536)
            .collect();
        assert_eq!(output, expected, "{needle}");
        assert!(!output.contains(secret), "{needle}");
        assert_eq!(stored["outputTruncated"], true, "{needle}");
        assert!(crate::acpx_event_payload::has_bounded_rich_display_shape(
            "tool.execution.completed",
            stored
        ));
    }
}

#[test]
fn redaction_growth_keeps_a_bounded_notice_summary_inside_its_schema_bound() {
    let config = config(PathBuf::from("unused"));
    let mut state = DurableState::new(&config);
    let summary = format!("token=abc {}", "y".repeat(3_990));
    assert_eq!(summary.chars().count(), 4_000);
    state
        .enqueue_event(&config, "provider.notice.recorded", EventPriority::P1, json!({
            "schema":"paperclip.provider.notice.v1","noticeId":"notice-1","severity":"info","category":"provider.status",
            "scope":"turn","recoverable":true,"userActionable":false,"summary":summary
        }))
        .unwrap();
    let stored = state.outbox[0]
        .envelope
        .pointer("/payload/payload")
        .unwrap();
    let stored_summary = stored["summary"].as_str().unwrap();
    assert_eq!(stored_summary.chars().count(), 4_000);
    assert!(stored_summary.starts_with("token=[REDACTED] y"));
    assert!(stored.get("outputTruncated").is_none());
}

#[test]
fn redaction_within_the_bound_leaves_short_tool_output_whole() {
    let config = config(PathBuf::from("unused"));
    let mut state = DurableState::new(&config);
    state
        .enqueue_event(&config, "tool.execution.completed", EventPriority::P1, json!({
            "schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"execute","status":"completed",
            "output":"before\ntoken=abc\nafter","outputBytes":22,"outputTruncated":false,"outputDigest":null
        }))
        .unwrap();
    let stored = state.outbox[0]
        .envelope
        .pointer("/payload/payload")
        .unwrap();
    assert_eq!(stored["output"], "before\ntoken=[REDACTED]\nafter");
    assert_eq!(stored["outputTruncated"], false);
}
