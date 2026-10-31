//! The database tools against a real SQLite data source of the project.

mod common;

use common::Harness;
use ide_core::CancellationToken;
use ide_core::mcp::McpUiRequest;
use ide_db::{DataSource, DbDriver};
use serde_json::{Value, json};

/// A project with data source `s1` (SQLite `app.db`): table `users` (3 rows), view `named`.
async fn project() -> Harness {
    let h = Harness::new(&[("README.md", "")]).await;
    std::fs::File::create(h.path("app.db")).unwrap();
    let db = h.host().project("main").unwrap().db.clone();
    db.save_sources(vec![DataSource {
        id: "s1".into(),
        name: "app".into(),
        driver: DbDriver::Sqlite,
        file: Some("app.db".into()),
        ..Default::default()
    }])
    .await
    .unwrap();
    let c = CancellationToken::new();
    for stmt in [
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)",
        "CREATE UNIQUE INDEX users_name ON users (name)",
        "CREATE VIEW named AS SELECT name FROM users",
        "INSERT INTO users (name, note) VALUES ('ann', NULL), ('bob', 'hi, there'), ('cy', '')",
    ] {
        db.execute("s1", stmt, 100, &c).await.unwrap();
    }
    h
}

fn schema(args: Value) -> Value {
    let mut a = json!({ "connectionId": "s1", "databaseName": "", "schemaName": "main" });
    a.as_object_mut().unwrap().extend(args.as_object().unwrap().clone());
    a
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_connections_schemas_kinds_and_objects() {
    let h = project().await;
    let list = h.call_json("list_database_connections", json!({})).await;
    let c = &list["connections"][0];
    assert_eq!(c["id"], "s1");
    assert_eq!(c["name"], "app");
    assert_eq!(c["dbms"], "SQLite");
    assert_eq!(c["driverName"], "SQLite");
    assert_eq!(c["isDDL"], false);
    assert_eq!(c["readOnly"], false);
    assert_eq!(c["jdbcUrl"], "jdbc:sqlite:app.db");

    let schemas = h.call_json("list_database_schemas", json!({ "connectionId": "s1" })).await;
    assert_eq!(schemas, json!({ "schemas": [{ "databaseName": "", "schemaName": "main", "isIntrospected": true }] }));

    let kinds = h.call_json("list_schema_object_kinds", json!({ "connectionId": "s1" })).await;
    assert_eq!(kinds["objectKinds"], json!([{ "code": "table", "name": "table" }, { "code": "view", "name": "view" }]));
    // Reading the schema asked for consent (the fake UI allows).
    assert!(matches!(
        &h.ui.asked.lock()[0],
        McpUiRequest::Confirm { title: Some(t), remember: Some(r), .. }
            if t == "Allow test-client to Read Database Schema" && r == "Always allow test-client to read database schemas"
    ));

    let objects = h.call_json("list_schema_objects", schema(json!({}))).await;
    assert_eq!(objects["schemaInfo"]["schemaName"], "main");
    assert_eq!(
        objects["schemaObjects"],
        json!([{ "name": "named", "kind": "view" }, { "name": "users", "kind": "table" }])
    );
    let tables = h.call_json("list_schema_objects", schema(json!({ "kind": "table" }))).await;
    assert_eq!(tables["schemaObjects"], json!([{ "name": "users", "kind": "table" }]));
    assert_eq!(
        h.call_err("list_schema_objects", schema(json!({ "kind": "TABLE" }))).await,
        "Unknown object kind: TABLE"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn describes_objects_and_finds_schemas_exactly() {
    let h = project().await;
    let d =
        h.call_json("get_database_object_description", schema(json!({ "kind": "table", "objectName": "USERS" }))).await;
    let text = d["definitions"][0].as_str().unwrap();
    assert!(text.starts_with("users: table\n    + columns\n        id: INTEGER\n        name: TEXT NN\n"), "{text}");
    assert!(text.contains("    + indices\n        users_name: unique (name)\n"), "{text}");
    assert!(text.contains("    + keys\n        #1: PK (id)\n"), "{text}");
    let none =
        h.call_json("get_database_object_description", schema(json!({ "kind": "view", "objectName": "users" }))).await;
    assert_eq!(none["definitions"], json!([]));

    assert_eq!(
        h.call_err("list_schema_objects", schema(json!({ "schemaName": "Main" }))).await,
        "Schema Main is not found"
    );
    assert_eq!(
        h.call_err("list_database_schemas", json!({ "connectionId": "nope" })).await,
        "Couldn't find connection with specified id"
    );
    let info = h.call_json("introspect_schema", schema(json!({ "databaseName": "whatever" }))).await;
    assert_eq!(info, json!({ "databaseName": "whatever", "schemaName": "main", "isIntrospected": true }));
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_queries_and_pages_through_results() {
    let h = project().await;
    let r = h
        .call_json("execute_sql_query", schema(json!({ "queryText": "select id, name, note from users order by id" })))
        .await;
    let id = r["resultSetId"].as_str().unwrap().to_owned();
    assert!(id.starts_with("qr_") && id.len() == 11, "{r}");
    assert_eq!(r["text"], "id,name,note\n1,ann,\n2,bob,\"hi, there\"\n3,cy,\"\"\n");
    assert!(r.get("errorMessage").is_none());

    let p = h.call_json("preview_table_data", schema(json!({ "tableName": "Users", "maxRowCount": 2 }))).await;
    let pid = p["resultSetId"].as_str().unwrap().to_owned();
    assert_eq!(p["text"], "id,name,note\n1,ann,\n2,bob,\"hi, there\"\n");
    let next = h.call_json("fetch_query_result", json!({ "resultSetId": pid, "offset": 2 })).await;
    assert_eq!(next["text"], "id,name,note\n3,cy,\"\"\n");
    let end = h.call_json("fetch_query_result", json!({ "resultSetId": pid, "offset": 3 })).await;
    assert_eq!(end["text"], "No more rows in the query result");
    let missing = h.call_json("fetch_query_result", json!({ "resultSetId": "qr_00000000", "offset": 0 })).await;
    assert_eq!(missing["errorMessage"], "Attempt to fetch query result has failed: Query result set was not found");
    assert_eq!(
        h.call_err("fetch_query_result", json!({ "resultSetId": " ", "offset": 0 })).await,
        "resultSetId cannot be empty or blank"
    );

    let write = h
        .call_json("execute_sql_query", schema(json!({ "queryText": "update users set note = 'x' where id = 1" })))
        .await;
    assert_eq!(write["text"], "Query executed successfully");
    let failed = h.call_json("execute_sql_query", schema(json!({ "queryText": "select * from nowhere" }))).await;
    assert_eq!(failed["resultSetId"], "");
    assert!(failed.get("text").is_none());
    let message = failed["errorMessage"].as_str().unwrap();
    assert!(message.starts_with("Attempt to execute query has failed: ") && message.contains("nowhere"), "{message}");
    assert_eq!(
        h.call_err("preview_table_data", schema(json!({ "tableName": "ghost" }))).await,
        "Database object main.ghost is not found"
    );

    // Each statement asked with its kind of consent.
    let titles: Vec<String> =
        h.ui.asked
            .lock()
            .iter()
            .filter_map(|r| match r {
                McpUiRequest::Confirm { title, .. } => title.clone(),
                _ => None,
            })
            .collect();
    assert_eq!(titles[0], "Allow test-client to Read Database Data");
    assert!(titles.contains(&"Allow test-client to Modify Database Data".to_owned()), "{titles:?}");

    // The tools' statements are listed in their own query session.
    let queries = h.call_json("list_recent_sql_queries", json!({ "connectionId": "s1" })).await;
    let all = queries["queries"].as_array().unwrap();
    // The setup statements ran in the console session, the tools' in another.
    assert_eq!(all[0]["queryText"], "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)");
    let q = all.iter().find(|q| q["sessionId"] != all[0]["sessionId"]).unwrap();
    assert_eq!(q["queryText"], "select id, name, note from users order by id");
    assert_eq!(q["state"], "FINISHED");
    assert_eq!(q["status"], "SUCCESS");
    let session = q["sessionId"].as_u64().unwrap();
    assert!(queries["queries"].as_array().unwrap().iter().any(|q| q["status"] == "ERROR"));
    assert_eq!(h.call("cancel_sql_query", json!({ "sessionId": session })).await, "[success]");
    assert_eq!(h.call_err("cancel_sql_query", json!({ "sessionId": 999_999 })).await, "Couldn't find database session");
}

#[tokio::test(flavor = "multi_thread")]
async fn consent_can_be_refused_remembered_and_read_only_sources_refuse_writes() {
    let h = project().await;
    *h.ui.answer.lock() = Value::Bool(false);
    assert_eq!(
        h.call_err("execute_sql_query", schema(json!({ "queryText": "delete from users" }))).await,
        "User rejected query."
    );
    assert_eq!(
        h.call_err("list_schema_object_kinds", json!({ "connectionId": "s1" })).await,
        "User does not allow to read database schemas in app"
    );
    assert_eq!(
        h.call_err("list_schema_objects", schema(json!({}))).await,
        "User does not allow to read SCHEMA:main schema in app"
    );

    // "Always allow": saved globally, not asked again.
    *h.ui.answer.lock() = json!({ "allow": true, "remember": true });
    h.call_json("execute_sql_query", schema(json!({ "queryText": "select 1" }))).await;
    assert!(h.host().global_settings.effective().mcp.database_consents.read_data);
    let asked = h.ui.asked.lock().len();
    *h.ui.answer.lock() = Value::Bool(false);
    h.call_json("execute_sql_query", schema(json!({ "queryText": "select 2" }))).await;
    assert_eq!(h.ui.asked.lock().len(), asked, "read data is allowed now");

    let db = h.host().project("main").unwrap().db.clone();
    let mut sources = db.sources().unwrap();
    sources[0].read_only = true;
    db.save_sources(sources).await.unwrap();
    assert_eq!(
        h.call_err("execute_sql_query", schema(json!({ "queryText": "drop table users" }))).await,
        "Schema or data modification queries are not allowed on read-only data sources."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_tests_and_edits_connections() {
    let h = project().await;
    std::fs::File::create(h.path("other.db")).unwrap();
    let created = h
        .call_json(
            "create_database_connection",
            json!({ "name": "other", "dbms": "SQLite", "url": "jdbc:sqlite:other.db", "needToCheckDs": false }),
        )
        .await;
    assert_eq!(created["hasProblems"], "UNSURE");
    let info = created["connectionInfo"].as_str().unwrap();
    let id = info.strip_prefix("ConnectionId: ").unwrap().to_owned();
    assert_eq!(
        created["summary"],
        "Connection test was skipped (needToCheckDs=false). Run `test_database_connection` if you want to verify this connection."
    );
    let tested = h.call_json("test_database_connection", json!({ "id": id })).await;
    assert_eq!(tested["hasProblems"], "NO", "{tested}");
    assert!(tested["connectionInfo"].as_str().unwrap().starts_with("DBMS: SQLite (ver. SQLite 3"), "{tested}");

    assert_eq!(
        h.call_err(
            "create_database_connection",
            json!({ "name": "other", "dbms": "SQLite", "url": "jdbc:sqlite:x.db", "needToCheckDs": false })
        )
        .await,
        "Datasource with name 'other' already exists"
    );
    let unknown = h
        .call_err(
            "create_database_connection",
            json!({ "name": "x", "dbms": "postgres", "url": "jdbc:postgresql://h/db", "needToCheckDs": false }),
        )
        .await;
    assert!(unknown.starts_with("DBMS name is not valid, use one from the list: [Amazon Aurora MySQL, "), "{unknown}");
    assert_eq!(
        h.call_err(
            "create_database_connection",
            json!({ "name": "x", "dbms": "PostgreSQL", "url": "jdbc:mysql://h/db", "needToCheckDs": false })
        )
        .await,
        "Invalid JDBC URL format for DBMS: PostgreSQL"
    );

    let edited = h
        .call_json(
            "edit_database_connection",
            json!({ "connectionId": id, "dbms": "SQLite", "url": "jdbc:sqlite:app.db", "needToCheckDs": true }),
        )
        .await;
    assert_eq!(edited["hasProblems"], "NO", "{edited}");
    assert!(edited["connectionInfo"].as_str().unwrap().starts_with(&format!("ConnectionId: {id}\r\nDBMS: SQLite")));
    let list = h.call_json("list_database_connections", json!({})).await;
    let other = list["connections"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone();
    assert_eq!(other["name"], "other");
    assert_eq!(other["jdbcUrl"], "jdbc:sqlite:app.db");
}
