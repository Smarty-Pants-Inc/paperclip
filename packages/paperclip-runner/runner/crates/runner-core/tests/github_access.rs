#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::github_access::{
    GitHubAccessIngress, MAX_GITHUB_ACCESS_BODY_BYTES,
};
use serde_json::json;

fn connect(socket_path: &Path) -> UnixStream {
    let stream = UnixStream::connect(socket_path).expect("connect to private runner socket");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
}

fn read_response(stream: &mut UnixStream) -> String {
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("read HTTP response");
    response
}

#[test]
fn ingress_forwards_one_exact_redacted_prp_frame_and_writes_its_reply() {
    let mut ingress = GitHubAccessIngress::start().expect("start private Unix socket ingress");
    let socket_path = ingress.socket_path().to_owned();
    let private_directory = socket_path.parent().unwrap();
    assert_eq!(
        std::fs::metadata(private_directory)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&socket_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_ne!(
        socket_path,
        GitHubAccessIngress::start().unwrap().socket_path(),
        "each launch receives a distinct private socket"
    );

    let mut client = connect(&socket_path);
    write!(
        client,
        "POST /runtime-tools/github/credentials HTTP/1.1\r\nHost: paperclip.local\r\nContent-Type: application/json\r\nAccept: application/json\r\nAuthorization: Bearer ghp_RFL_SENTINEL_TOKEN\r\nx-paperclip-github-capability: ghp_RFL_SENTINEL_TOKEN\r\nx-paperclip-bridge-generation: run-generation-1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let request = loop {
        if let Some(request) = ingress.try_next_request() {
            break request;
        }
        assert!(
            Instant::now() < deadline,
            "local HTTP request was not queued"
        );
        thread::sleep(Duration::from_millis(5));
    };
    let request_id = request.request_id().to_owned();
    assert_eq!(
        request.frame(),
        &json!({
            "kind": "github_access.http",
            "requestId": request_id,
            "method": "POST",
            "path": "/runtime-tools/github/credentials",
            "headers": {
                "content-type": "application/json",
                "accept": "application/json",
                "x-paperclip-bridge-generation": "run-generation-1"
            },
            "bodyBase64": "e30="
        })
    );
    assert!(!request
        .frame()
        .to_string()
        .contains("ghp_RFL_SENTINEL_TOKEN"));
    assert_eq!(request.frame().as_object().unwrap().len(), 6);

    request
        .respond(json!({
            "requestId": request_id,
            "status": 200,
            "headers": { "content-type": "application/json", "cache-control": "no-store" },
            "bodyBase64": "eyJzdGF0dXMiOiJhdmFpbGFibGUifQ=="
        }))
        .expect("deliver one matching ingress reply");
    let response = read_response(&mut client);
    assert!(response.starts_with("HTTP/1.1 200 "), "{response}");
    assert!(
        response.contains("{\"status\":\"available\"}"),
        "{response}"
    );
}

#[test]
fn private_socket_preserves_the_existing_browser_header_refusal() {
    let mut ingress = GitHubAccessIngress::start().expect("start private Unix socket ingress");
    let mut browser_request = connect(ingress.socket_path());
    write!(
        browser_request,
        "POST /runtime-tools/github/credentials HTTP/1.1\r\nHost: paperclip.local\r\nOrigin: https://example.test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
    .unwrap();
    let response = read_response(&mut browser_request);
    assert!(response.starts_with("HTTP/1.1 403 "), "{response}");
    assert!(ingress.try_next_request().is_none());
}

#[test]
fn private_socket_returns_the_named_503_while_ingress_is_unavailable() {
    let mut ingress = GitHubAccessIngress::start().expect("start private Unix socket ingress");
    ingress.set_available(false);
    let mut client = connect(ingress.socket_path());
    write!(
        client,
        "POST /runtime-tools/github/credentials HTTP/1.1\r\nHost: paperclip.local\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
    .unwrap();
    let response = read_response(&mut client);
    assert!(response.starts_with("HTTP/1.1 503 "), "{response}");
    assert!(
        response.contains("runner ingress unavailable"),
        "{response}"
    );
    assert!(ingress.try_next_request().is_none());
}

#[test]
fn private_socket_rejects_oversized_bodies_before_forwarding() {
    let mut ingress = GitHubAccessIngress::start().expect("start private Unix socket ingress");
    let mut oversized = connect(ingress.socket_path());
    write!(
        oversized,
        "POST /runtime-tools/github/credentials HTTP/1.1\r\nHost: paperclip.local\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        MAX_GITHUB_ACCESS_BODY_BYTES + 1
    )
    .unwrap();
    let response = read_response(&mut oversized);
    assert!(response.starts_with("HTTP/1.1 413 "), "{response}");
    assert!(ingress.try_next_request().is_none());
    assert_eq!(MAX_GITHUB_ACCESS_BODY_BYTES, 10 * 1024 * 1024 + 64 * 1024);
}
