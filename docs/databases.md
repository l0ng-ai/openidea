# Databases

The Database tool window (View ▸ Tool Windows ▸ Database) connects to SQLite,
PostgreSQL, MySQL/MariaDB, Microsoft SQL Server, ClickHouse and Oracle, plus the
wire-compatible products listed in **New ▸ Data Source**. Connections are saved
per project in `.openidea/data-sources.toml`; passwords live outside the project
(and never in that file).

## Oracle: Oracle Instant Client

Oracle support uses the Oracle Call Interface, so the Oracle client libraries
must be installed on the machine. OpenIDEA does not bundle them: install the
**Oracle Instant Client** for your platform and point the data source at it.

1. Download the _Basic_ (or _Basic Light_) package of Oracle Instant Client
   19c or later for your OS from
   <https://www.oracle.com/database/technologies/instant-client/downloads.html>.
2. Unpack it somewhere stable, then, in the data source's **Options** tab, set
   **Instant Client** to that directory.
3. General tab: host, port (1521), and the **service name** (for example
   `ORCLPDB1`) in the Database field. Connect with the schema's user and its
   password.

`java.sql`-style URLs also work in the URL field:

```
oracle://scott:tiger@db.example.com:1521/ORCLPDB1
jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1
```

A TNS descriptor or alias in the Database field is passed to the client as is.

### Platform notes

- **macOS** — the _Basic_ ZIP for ARM (Apple silicon) or x86-64 must match the
  app's architecture. Remove the quarantine flag if macOS blocks the libraries:
  `xattr -dr com.apple.quarantine /opt/oracle/instantclient_23_5`.
- **Windows** — use the 64-bit package; the app is 64-bit. `PATH` does not have
  to include the directory when the Options tab names it.
- **Linux** — install the RPM/DEB or unzip the ZIP; the directory needs the
  `libclntsh.so` and `libclntshcore.so` libraries (the ZIP's `libaio`-based
  builds also need the `libaio` package).

Without a working client, Test Connection fails with a clear message
(`DPI-1047: Cannot locate a 64-bit Oracle Client library…`). If the Options tab
is empty and `ORACLE_HOME` is not set, the client is looked up on the system
search path.

### What Oracle data sources support

- Schemas = Oracle users (`ALL_USERS`); system accounts (`SYS`, `SYSTEM`,
  `XDB`, `MDSYS`…) appear only with **Schemas ▸ Show system**.
- Tables, views, columns, indexes, foreign keys, triggers, routines and
  sequences are read from the `ALL_*` views.
- The query console runs SQL and PL/SQL blocks; `BEGIN … END;` blocks (nested
  `;` included) are sent as one statement, and a lone `/` on its own line ends
  one as in SQL*Plus.
- Explain Plan runs `EXPLAIN PLAN` and reads `PLAN_TABLE` (`DBMS_XPLAN` output
  is not required).
- Table editor (INSERT/UPDATE/DELETE in one transaction), Import/Export and
  generated SQL use Oracle syntax: `"UPPER_CASE"` identifiers, `FETCH FIRST n
  ROWS ONLY`, `MODIFY (…)` for column changes.

Table editing needs a primary key, and the connection must not be read-only.
