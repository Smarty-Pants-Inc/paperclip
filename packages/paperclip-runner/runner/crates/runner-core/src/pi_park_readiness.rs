//! Volatile Pi facade park proof. Never restore this from a durable checkpoint:
//! only this app-server process can report its extension's current liveness.
use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

const MAX_TOOL_OBLIGATIONS: usize = 1024;

#[derive(Default)]
pub(super) struct PiParkReadiness {
    reported_ready: bool,
    tools: BTreeSet<(String, String)>,
    uncertain_activity: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    schema: String,
    thread_id: String,
    turn_id: String,
    ready: bool,
    reasons: Vec<String>,
}

impl PiParkReadiness {
    /// Returns true only for the private facade notification, which must not
    /// become a canonical event or grant terminal/result authority.
    pub(super) fn observe(
        &mut self,
        message: &Value,
        thread_id: &str,
        active_turn_id: Option<&str>,
        completed_turn_id: Option<&str>,
    ) -> bool {
        // A report qualifies one FIFO cut, not all future activity. Even an
        // otherwise ignored late frame requires a new extension observation.
        self.reported_ready = false;
        let method = message.get("method").and_then(Value::as_str);
        let params = &message["params"];
        if method == Some("paperclip/parkReady") {
            if message.get("id").is_none() {
                if let Ok(report) = serde_json::from_value::<Report>(params.clone()) {
                    self.reported_ready = report.schema == "paperclip.pi.park-ready.v1"
                        && report.thread_id == thread_id
                        && Some(report.turn_id.as_str()) == completed_turn_id
                        && active_turn_id.is_none()
                        && report.ready
                        && report.reasons.is_empty();
                }
            }
            return true;
        }

        let bound_turn = params.get("turnId").and_then(Value::as_str);
        let bound = params.get("threadId").and_then(Value::as_str) == Some(thread_id)
            && bound_turn.is_some()
            && (bound_turn == active_turn_id || bound_turn == completed_turn_id);
        if bound
            && matches!(
                method,
                Some("item/started" | "item/updated" | "item/completed")
            )
            && matches!(
                params.pointer("/item/type").and_then(Value::as_str),
                Some("builtinToolCall" | "mcpToolCall" | "dynamicToolCall" | "commandExecution")
            )
        {
            let id = params
                .pointer("/item/id")
                .or_else(|| params.get("itemId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 512);
            let Some(id) = id else {
                self.uncertain_activity = true;
                return false;
            };
            let key = (bound_turn.expect("bound turn").to_owned(), id.to_owned());
            if method == Some("item/completed") {
                self.tools.remove(&key);
            } else if self.tools.len() < MAX_TOOL_OBLIGATIONS {
                self.tools.insert(key);
            } else {
                self.uncertain_activity = true;
            }
        }
        false
    }

    pub(super) fn invalidate(&mut self) {
        self.reported_ready = false;
    }

    pub(super) fn ready(&self) -> bool {
        self.reported_ready && self.tools.is_empty() && !self.uncertain_activity
    }
}
