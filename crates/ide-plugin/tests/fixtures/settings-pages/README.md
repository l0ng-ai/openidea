# Multi-page settings example (API 1.3)

Two IDE-rendered pages demonstrate grouped string lists and an editable model
profile table. `Test` first applies pending settings, then runs the declared
`test` command. With no profiles it returns an inline error; after adding a row
it reads the saved JSON array and reports success through a notification.
This fixture checks the settings/action flow; it does not contact a provider.

Build with `plugins/build.sh crates/ide-plugin/tests/fixtures/settings-pages`.
Install or link this directory with `openidea-plugin link` and open
Settings › Plugins › Model Profiles. Edit without Apply and Cancel to discard;
Apply or OK saves. Running Test also saves pending edits before the command,
so Cancel after Test does not undo those already-applied edits.

API keys belong in `[[contributes.secrets]]`, never table cells. A real Test
connection command can use `host::fetch` with the appropriate declared network
capability and secret-backed headers.
