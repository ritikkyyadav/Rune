use alan_core::protocol::SessionEvent;
use alan_core::session::SessionManager;
use tempfile::TempDir;

fn create_test_manager() -> (SessionManager, TempDir) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let mgr = SessionManager::open(&db_path).unwrap();
    (mgr, tmp)
}

#[test]
fn create_session_returns_valid_info() {
    let (mgr, _tmp) = create_test_manager();

    let session = mgr
        .create_session("/home/user/project", "claude-sonnet-4-20250514")
        .unwrap();

    assert_eq!(session.workspace_root, "/home/user/project");
    assert_eq!(session.model, "claude-sonnet-4-20250514");
    assert_eq!(session.event_count, 0);
    assert!(session.title.is_none());
}

#[test]
fn list_sessions_returns_created_sessions() {
    let (mgr, _tmp) = create_test_manager();

    mgr.create_session("/project/a", "model-a").unwrap();
    mgr.create_session("/project/b", "model-b").unwrap();

    let sessions = mgr.list_sessions().unwrap();
    assert_eq!(sessions.len(), 2);

    // Ordered by updated_at DESC, so second created is first listed
    assert_eq!(sessions[0].workspace_root, "/project/b");
    assert_eq!(sessions[1].workspace_root, "/project/a");
}

#[test]
fn append_event_increments_sequence() {
    let (mgr, _tmp) = create_test_manager();
    let session = mgr.create_session("/project", "model").unwrap();

    let seq1 = mgr
        .append_event(
            &session.id,
            &SessionEvent::UserMessage {
                content: "Hello".to_string(),
            },
        )
        .unwrap();

    let seq2 = mgr
        .append_event(
            &session.id,
            &SessionEvent::AssistantMessage {
                content: "Hi there".to_string(),
            },
        )
        .unwrap();

    assert_eq!(seq1, 1);
    assert_eq!(seq2, 2);
}

#[test]
fn get_events_returns_appended_events() {
    let (mgr, _tmp) = create_test_manager();
    let session = mgr.create_session("/project", "model").unwrap();

    mgr.append_event(
        &session.id,
        &SessionEvent::UserMessage {
            content: "first".to_string(),
        },
    )
    .unwrap();

    mgr.append_event(
        &session.id,
        &SessionEvent::AssistantMessage {
            content: "second".to_string(),
        },
    )
    .unwrap();

    mgr.append_event(
        &session.id,
        &SessionEvent::ToolCall {
            call_id: "tc_1".to_string(),
            tool_name: "read_file".to_string(),
            args: serde_json::json!({"path": "/foo.rs"}),
        },
    )
    .unwrap();

    let events = mgr.get_events(&session.id, 1, None).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].0, 1); // seq
    assert_eq!(events[2].0, 3);

    // Verify deserialized types
    match &events[0].1 {
        SessionEvent::UserMessage { content } => assert_eq!(content, "first"),
        _ => panic!("Expected UserMessage"),
    }
    match &events[2].1 {
        SessionEvent::ToolCall {
            tool_name, args, ..
        } => {
            assert_eq!(tool_name, "read_file");
            assert_eq!(args["path"], "/foo.rs");
        }
        _ => panic!("Expected ToolCall"),
    }
}

#[test]
fn get_events_with_offset_and_limit() {
    let (mgr, _tmp) = create_test_manager();
    let session = mgr.create_session("/project", "model").unwrap();

    for i in 1..=10 {
        mgr.append_event(
            &session.id,
            &SessionEvent::UserMessage {
                content: format!("msg {i}"),
            },
        )
        .unwrap();
    }

    // Get events starting from seq 5, limit 3
    let events = mgr.get_events(&session.id, 5, Some(3)).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].0, 5);
    assert_eq!(events[2].0, 7);
}

#[test]
fn list_sessions_shows_event_count() {
    let (mgr, _tmp) = create_test_manager();
    let session = mgr.create_session("/project", "model").unwrap();

    mgr.append_event(
        &session.id,
        &SessionEvent::UserMessage {
            content: "a".to_string(),
        },
    )
    .unwrap();
    mgr.append_event(
        &session.id,
        &SessionEvent::AssistantMessage {
            content: "b".to_string(),
        },
    )
    .unwrap();

    let sessions = mgr.list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].event_count, 2);
}

#[test]
fn empty_session_returns_no_events() {
    let (mgr, _tmp) = create_test_manager();
    let session = mgr.create_session("/project", "model").unwrap();

    let events = mgr.get_events(&session.id, 1, None).unwrap();
    assert!(events.is_empty());
}
