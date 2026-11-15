use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::github_access::{
    GitHubAccessIngress, MAX_GITHUB_ACCESS_BODY_BYTES,
};
use serde_json::json;

fn connect(url: &str) -> (TcpStream, String) {
    let authority = url
        .strip_prefix("http://")
        .expect("local listener uses HTTP")
        .split_once('/')
        .expect("URL includes its private path")
        .0;
    let address = authority
        .to_socket_addrs()
        .expect("resolve loopback listener")
        .next()
        .expect("listener address");
    let stream = TcpStream::connect(address).expect("connect to loopback listener");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    (stream, authority.to_owned())
}

fn read_response(stream: &mut TcpStream) -> String {
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read HTTP response");
    response
}

#[test]
fn ingress_forwards_one_exact_redacted_prp_frame_and_writes_its_reply() {
    let mut ingress = GitHubAccessIngress::start().expect("start private loopback ingress");
    assert!(ingress.local_addr().ip().is_loopback());
    let (mut client, _) = connect(ingress.local_url());
    let private_prefix = ingress
        .local_url()
        .strip_prefix(&format!("http://{}", ingress.local_addr()))
        .unwrap();
    write!(
        client,
        "POST {private_prefix}/runtime-tools/github/credentials HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json\r\nAuthorization: Bearer ghp_RFL_SENTINEL_TOKEN\r\nx-paperclip-github-capability: ghp_RFL_SENTINEL_TOKEN\r\nx-paperclip-bridge-generation: run-generation-1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut request = loop {
        if let Some(request) = ingress.try_next_request() {
            break request;
        }
        assert!(Instant::now() < deadline, "local HTTP request was not queued");
        std::thread::sleep(Duration::from_millis(5));
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
    assert!(!request.frame().to_string().contains("ghp_RFL_SENTINEL_TOKEN"));
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
    assert!(response.contains("{\"status\":\"available\"}"), "{response}");
}

#[test]
fn loopback_listener_requires_its_per_launch_path_secret_and_bounds_bodies() {
    let mut ingress = GitHubAccessIngress::start().expect("start private loopback ingress");
    let (mut client, authority) = connect(ingress.local_url());
    write!(
        client,
        "POST /wrong-secret/runtime-tools/github/credentials HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let response = read_response(&mut client);
    assert!(response.starts_with("HTTP/1.1 404 "), "{response}");
    assert!(ingress.try_next_request().is_none());

    let (mut oversized, _) = connect(ingress.local_url());
    let private_prefix = ingress
        .local_url()
        .strip_prefix(&format!("http://{}", ingress.local_addr()))
        .unwrap();
    write!(
        oversized,
        "POST {private_prefix}/runtime-tools/github/credentials HTTP/1.1\r\nHost: {authority}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        MAX_GITHUB_ACCESS_BODY_BYTES + 1
    )
    .unwrap();
    let response = read_response(&mut oversized);
    assert!(response.starts_with("HTTP/1.1 413 "), "{response}");
    assert!(ingress.try_next_request().is_none());
    assert_eq!(MAX_GITHUB_ACCESS_BODY_BYTES, 10 * 1024 * 1024 + 64 * 1024);
}
