Throwaway keys for the Snowflake key-pair tests. They were generated for this repository,
are registered with no account, and protect nothing.

| File | Format |
|---|---|
| `rsa_key.p8` | PKCS#8, unencrypted, RSA 2048 |
| `rsa_key_encrypted.p8` | PKCS#8, PBES2 (PBKDF2 + AES-256-CBC), passphrase `test-passphrase` |
| `rsa_key_scrypt.p8` | PKCS#8, PBES2 (scrypt + AES-256-CBC), passphrase `test-passphrase` |
| `rsa_key_pkcs1.pem` | PKCS#1 (`BEGIN RSA PRIVATE KEY`), unencrypted |
| `rsa_key_legacy_encrypted.pem` | PKCS#1 with `Proc-Type: 4,ENCRYPTED` (rejected) |
| `rsa_key_1024.p8` | RSA 1024 (rejected: too short) |
| `ec_key.p8` | EC P-256 (rejected: not RSA) |
| `rsa_key.pub` | Public key of `rsa_key.p8` |

Fingerprint of `rsa_key.pub` from OpenSSL
(`openssl rsa -pubin -in rsa_key.pub -outform DER | openssl dgst -sha256 -binary | openssl enc -base64`):
`ajjL6Bf6l1FIIyTcJli4i2AWPYDVJGQnSZr+9q9ClgI=`

`commands.json` holds one sample statement for every command of Snowflake's SQL reference
(<https://docs.snowflake.com/en/sql-reference/sql-all>, 786 names). The driver's tests
(`src/snowflake/commands.rs`) and the console's (`src/features/database/sql/snowflakeCommands.test.ts`)
run all of them; the ignored live test runs the listing ones against a real account. `reads`: allowed
on a read-only data source. `rerunnable`: safe to run again for another page of the result. The
samples exercise the client, not Snowflake's grammar, and name no real object.
