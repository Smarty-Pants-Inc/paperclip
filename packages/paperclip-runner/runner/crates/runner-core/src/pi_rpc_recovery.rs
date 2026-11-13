use serde_json::Value;

/// The trusted Pi facade may explicitly quarantine invalid saved history and
/// open fresh. This is not ordinary resume and never permits an unannounced
/// identity mismatch (nor any replacement for another provider).
pub(crate) fn admits_fresh_session(provider: &str, expected: &str, opened: &Value) -> bool {
    let admission = &opened["piNativeAdmission"];
    let recovery = &admission["sessionRecovery"];
    let id = opened.pointer("/thread/id").and_then(Value::as_str);
    provider == "pi_rpc"
        && recovery["reason"] == "pi_session_file_invalid"
        && recovery["previousSessionId"] == expected
        && recovery["normalizedSessionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && recovery["preservedFile"]
            .as_str()
            .is_some_and(|file| !file.contains(['/', '\\']) && file.contains(".jsonl.invalid-"))
        && id.is_some_and(|id| !id.is_empty() && id != expected)
        && opened.pointer("/thread/sessionId").and_then(Value::as_str) == id
        && admission["providerSessionId"].as_str() == id
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pi_rpc_fresh_session_requires_explicit_scoped_preservation_receipt() {
        let receipt = json!({"thread": {"id": "new", "sessionId": "new"},
        "piNativeAdmission": {"providerSessionId": "new", "sessionRecovery": {
            "reason": "pi_session_file_invalid", "previousSessionId": "old",
            "normalizedSessionId": "conversation", "preservedFile": "conversation.jsonl.invalid-2026-11-13T00-00-00Z-unique"
        }}});
        assert!(admits_fresh_session("pi_rpc", "old", &receipt));
        assert!(!admits_fresh_session("codex", "old", &receipt));
        assert!(!admits_fresh_session("pi_rpc", "another", &receipt));
        for pointer in [
            "/piNativeAdmission/sessionRecovery/reason",
            "/piNativeAdmission/sessionRecovery/previousSessionId",
            "/piNativeAdmission/sessionRecovery/preservedFile",
            "/piNativeAdmission/sessionRecovery/normalizedSessionId",
            "/thread/sessionId",
            "/piNativeAdmission/providerSessionId",
        ] {
            let mut invalid = receipt.clone();
            *invalid.pointer_mut(pointer).unwrap() = Value::Null;
            assert!(
                !admits_fresh_session("pi_rpc", "old", &invalid),
                "{pointer}"
            );
        }
    }
}
