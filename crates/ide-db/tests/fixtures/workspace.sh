#!/usr/bin/env bash
# Requires Docker, curl and Cargo. To exercise the JOIN and its cancellation as well
# as source reads, install Java 17+ and set DUCKDB_JDBC_JAR to an absolute JAR path.
# Usage: bash crates/ide-db/tests/fixtures/workspace.sh [command args...]
set -euo pipefail

cd "$(dirname "$0")/../../../.."
fixtures=$(mktemp -d "${TMPDIR:-/tmp}/openidea-workspace.XXXXXXXX")
pg=
ch=
cleanup() {
    if [[ -n "$ch" ]]; then docker stop -t 2 "$ch" >/dev/null || true; fi
    if [[ -n "$pg" ]]; then docker stop -t 2 "$pg" >/dev/null || true; fi
    rm -f "$fixtures/users.xml"
    rmdir "$fixtures"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$fixtures/users.xml" <<'XML'
<clickhouse>
  <profiles>
    <workspace_strict>
      <readonly>1</readonly>
      <max_threads>1</max_threads>
      <max_memory_usage>134217728</max_memory_usage>
      <max_rows_to_read>100000</max_rows_to_read>
      <max_execution_time>20</max_execution_time>
    </workspace_strict>
  </profiles>
  <users>
    <fixture_writer>
      <no_password/>
      <networks><ip>::/0</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
    </fixture_writer>
    <fixture_strict>
      <no_password/>
      <networks><ip>::/0</ip></networks>
      <profile>workspace_strict</profile>
      <quota>default</quota>
    </fixture_strict>
  </users>
</clickhouse>
XML
chmod 644 "$fixtures/users.xml"

pg=$(docker run --rm -d -p 127.0.0.1::5432 --cpus 1 --memory 320m \
    --tmpfs /var/lib/postgresql/data:rw,size=128m \
    -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)
ch=$(docker run --rm -d -p 127.0.0.1::8123 --cpus 1 --memory 1536m \
    --tmpfs /var/lib/clickhouse --tmpfs /var/log/clickhouse-server \
    --mount "type=bind,source=$fixtures/users.xml,target=/etc/clickhouse-server/users.d/workspace-fixture.xml,readonly" \
    clickhouse/clickhouse-server:25.8.12.129)
WORKSPACE_PG_PORT=$(docker port "$pg" 5432/tcp | sed 's/^127\.0\.0\.1://')
WORKSPACE_CH_PORT=$(docker port "$ch" 8123/tcp | sed 's/^127\.0\.0\.1://')
export WORKSPACE_PG_PORT WORKSPACE_CH_PORT
ch_http="http://127.0.0.1:$WORKSPACE_CH_PORT"

ready() {
    for ((attempt = 0; attempt < 45; ++attempt)); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    printf 'Workspace fixture did not become ready: %s\n' "$1" >&2
    return 1
}
ready docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres
ready curl -fsS --max-time 1 "$ch_http/ping"

docker exec -i "$pg" psql -h 127.0.0.1 -U postgres -Xq -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE "exact data" ("exact key" numeric(32,6), id bigint, ts timestamp(6) with time zone, label text);
INSERT INTO "exact data" VALUES
  (100000000000000000001.000001, 9007199254740993, '2025-01-03 07:05:06.123456+03', E'a,b"c\nd'),
  (100000000000000000002.000001, 9007199254740994, NULL, ''),
  (NULL, 9007199254740995, NULL, NULL);
CREATE TABLE "empty data" (LIKE "exact data");
CREATE TABLE "unsupported data" (payload jsonb);
CREATE VIEW "fixture view" AS SELECT * FROM "exact data";
SQL

ch_sql() {
    curl -fsS --max-time 5 --user fixture_writer: --data-binary "$1" "$ch_http/"
}
ch_sql "CREATE TABLE default.\"exact data\" (
    \"exact key\" Nullable(Decimal(32,6)), id Int64, ts Nullable(DateTime64(6, 'Europe/Moscow')), label Nullable(String)
) ENGINE=Memory"
ch_sql "INSERT INTO default.\"exact data\" VALUES
    (100000000000000000001.000001, 9007199254740993, '2025-01-03 07:05:06.123456', 'a,b\"c\\nd'),
    (100000000000000000002.000001, 9007199254740994, NULL, ''),
    (NULL, 9007199254740995, NULL, NULL)"
ch_sql 'CREATE TABLE default."empty data" AS default."exact data" ENGINE=Memory'
ch_sql 'CREATE TABLE default."unsupported data" (payload Array(String)) ENGINE=Memory'
ch_sql 'CREATE VIEW default."fixture view" AS SELECT * FROM default."exact data"'
ch_sql 'CREATE TABLE default."unsigned data" (id UInt64) ENGINE=Memory'
ch_sql 'INSERT INTO default."unsigned data" VALUES (9007199254740992), (9007199254740993), (18446744073709551615)'

export WORKSPACE_CH_USER=fixture_writer
if (( $# > 0 )); then
    "$@"
else
    test_name=workspace_input::tests::native_workspace_sources_are_exact_and_fail_on_limits
    cargo test --locked -p ide-db --lib "$test_name" -- --ignored
    WORKSPACE_CH_USER=fixture_strict cargo test --locked -p ide-db --lib "$test_name" -- --ignored
fi
