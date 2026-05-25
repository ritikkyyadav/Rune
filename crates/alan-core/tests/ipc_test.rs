use alan_core::ipc::{IpcClient, IpcContext, IpcServer};
use alan_core::protocol::{JsonRpcRequest, RequestId};
use alan_core::session::SessionManager;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

fn make_context(tmp: &TempDir) -> Arc<IpcContext> {
    let db_path = tmp.path().join("test.db");
    let sessions = SessionManager::open(&db_path).unwrap();
    Arc::new(IpcContext {
        sessions: Mutex::new(sessions),
    })
}

#[tokio::test]
async fn ping_returns_pong_with_version() {
    let tmp = TempDir::new().unwrap();
    let sock = tmp.path().join("test.sock");
    let ctx = make_context(&tmp);

    let mut server = IpcServer::new(sock.clone(), ctx);
    server.start().await.unwrap();

    // Spawn accept loop in background
    tokio::spawn(async move {
        server.accept_loop().await.unwrap();
    });

    // Give the server a moment to be ready
    sleep(Duration::from_millis(50)).await;

    let mut client = IpcClient::connect(&sock).await.unwrap();

    let request = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: RequestId::Number(1),
        method: "ping".to_string(),
        params: None,
    };

    let response = client.call(request).await.unwrap();

    assert!(response.error.is_none());
    let result = response.result.unwrap();
    assert_eq!(result["result"], "pong");
    assert_eq!(result["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn unknown_method_returns_method_not_found() {
    let tmp = TempDir::new().unwrap();
    let sock = tmp.path().join("test.sock");
    let ctx = make_context(&tmp);

    let mut server = IpcServer::new(sock.clone(), ctx);
    server.start().await.unwrap();

    tokio::spawn(async move {
        server.accept_loop().await.unwrap();
    });

    sleep(Duration::from_millis(50)).await;

    let mut client = IpcClient::connect(&sock).await.unwrap();

    let request = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: RequestId::String("abc".to_string()),
        method: "nonexistent.method".to_string(),
        params: None,
    };

    let response = client.call(request).await.unwrap();

    assert!(response.result.is_none());
    let err = response.error.unwrap();
    assert_eq!(err.code, alan_core::protocol::error_codes::METHOD_NOT_FOUND);
    assert!(err.message.contains("nonexistent.method"));
}

#[tokio::test]
async fn multiple_requests_on_same_connection() {
    let tmp = TempDir::new().unwrap();
    let sock = tmp.path().join("test.sock");
    let ctx = make_context(&tmp);

    let mut server = IpcServer::new(sock.clone(), ctx);
    server.start().await.unwrap();

    tokio::spawn(async move {
        server.accept_loop().await.unwrap();
    });

    sleep(Duration::from_millis(50)).await;

    let mut client = IpcClient::connect(&sock).await.unwrap();

    for i in 1..=5 {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: RequestId::Number(i),
            method: "ping".to_string(),
            params: None,
        };

        let response = client.call(request).await.unwrap();
        assert!(response.error.is_none());
        assert_eq!(response.result.unwrap()["result"], "pong");
    }
}
