//! Key-pair authentication: reads the user's RSA private key file and signs the login JWT.
//! Parsing, decryption and signing are RustCrypto's (`rsa`, `pkcs8`, `pkcs5`).

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use rsa::RsaPrivateKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{EncodePublicKey, EncryptedPrivateKeyInfoRef, PrivateKeyInfoRef, SecretDocument};
use rsa::sha2::{Digest, Sha256};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::traits::PublicKeyParts;
use zeroize::Zeroizing;

/// Snowflake rejects a JWT that lives longer than an hour.
const LIFETIME_SECS: u64 = 59 * 60;
const MIN_BITS: usize = 2048;
const CONVERT: &str = "openssl pkcs8 -topk8 -v2 aes-256-cbc -in <key file> -out rsa_key.p8";

pub(crate) struct KeyPair {
    key: RsaPrivateKey,
}

fn invalid(message: impl Into<String>) -> IdeError {
    IdeError::invalid(message)
}

/// The UI answers `PermissionDenied` by asking for the secret, here the key's passphrase.
fn passphrase_error(message: &str) -> IdeError {
    IdeError::new(ErrorKind::PermissionDenied, message)
}

/// Reads the private key file at `path` (`~/` is the home directory).
pub(crate) fn load(path: &str, passphrase: Option<&str>) -> IdeResult<KeyPair> {
    let path = path.trim();
    if path.is_empty() {
        return Err(invalid("select the private key file of the Snowflake user"));
    }
    let file = ide_ssh::expand(path);
    let bytes = Zeroizing::new(
        std::fs::read(&file)
            .map_err(|e| invalid(format!("cannot read the private key file {}: {e}", file.display())))?,
    );
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Err(invalid(format!(
            "{} is not a PEM file; convert a DER key with: openssl pkcs8 -inform DER -outform PEM -in <key file> -out rsa_key.p8",
            file.display()
        )));
    };
    parse(text, passphrase)
}

pub(crate) fn parse(pem: &str, passphrase: Option<&str>) -> IdeResult<KeyPair> {
    let pem = pem.trim();
    if pem.contains("Proc-Type: 4,ENCRYPTED") {
        return Err(invalid(format!(
            "the private key uses the legacy encrypted PEM format; convert it to PKCS#8 with: {CONVERT}"
        )));
    }
    if pem.contains("BEGIN OPENSSH PRIVATE KEY") {
        return Err(invalid(
            "the private key is in OpenSSH format; convert it to PKCS#8 with: ssh-keygen -p -m PKCS8 -f <key file>",
        ));
    }
    let (label, document) = SecretDocument::from_pem(pem).map_err(|_| {
        if pem.contains("PRIVATE KEY-----") {
            invalid("the private key file is damaged")
        } else {
            invalid("the private key file holds no PEM private key (expected -----BEGIN PRIVATE KEY-----)")
        }
    })?;
    let key = match label {
        "PRIVATE KEY" => from_pkcs8(document.as_bytes(), "the private key file is damaged")?,
        "ENCRYPTED PRIVATE KEY" => {
            let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) else {
                return Err(passphrase_error("the private key is encrypted; enter its passphrase"));
            };
            let encrypted = EncryptedPrivateKeyInfoRef::try_from(document.as_bytes())
                .map_err(|_| invalid("the encrypted private key file is damaged"))?;
            let decrypted = encrypted.decrypt(passphrase).map_err(|error| match error {
                rsa::pkcs8::Error::EncryptedPrivateKey(rsa::pkcs8::pkcs5::Error::DecryptFailed) => {
                    passphrase_error("incorrect passphrase for the private key")
                }
                rsa::pkcs8::Error::EncryptedPrivateKey(_) => invalid(format!(
                    "the private key is encrypted with an unsupported algorithm; re-encrypt it with: {CONVERT}"
                )),
                _ => invalid("the encrypted private key file is damaged"),
            })?;
            // A wrong passphrase can leave valid padding around bytes that are no key.
            from_pkcs8(decrypted.as_bytes(), "incorrect passphrase for the private key").map_err(|error| {
                if error.message.starts_with("incorrect passphrase") { passphrase_error(&error.message) } else { error }
            })?
        }
        "RSA PRIVATE KEY" => RsaPrivateKey::from_pkcs1_der(document.as_bytes())
            .map_err(|_| invalid("the private key file is damaged"))?,
        "PUBLIC KEY" | "RSA PUBLIC KEY" => {
            return Err(invalid("this file holds the public key; select the private key file"));
        }
        "EC PRIVATE KEY" => return Err(not_rsa()),
        other => return Err(invalid(format!("unsupported private key format: {other}"))),
    };
    let bits = key.size() * 8;
    if bits < MIN_BITS {
        return Err(invalid(format!("the RSA key has {bits} bits; Snowflake requires at least {MIN_BITS}")));
    }
    Ok(KeyPair { key })
}

fn not_rsa() -> IdeError {
    invalid("the private key is not an RSA key; Snowflake key-pair authentication needs an RSA key")
}

fn from_pkcs8(der: &[u8], malformed: &str) -> IdeResult<RsaPrivateKey> {
    let info = PrivateKeyInfoRef::try_from(der).map_err(|_| invalid(malformed))?;
    if info.algorithm.oid != rsa::pkcs1::ALGORITHM_OID {
        return Err(not_rsa());
    }
    RsaPrivateKey::try_from(info).map_err(|_| invalid(malformed))
}

impl KeyPair {
    /// `SHA256:<base64>` of the public key, as `DESC USER` shows it in `RSA_PUBLIC_KEY_FP`.
    pub(crate) fn fingerprint(&self) -> IdeResult<String> {
        let der = self
            .key
            .to_public_key()
            .to_public_key_der()
            .map_err(|e| IdeError::internal(format!("cannot encode the public key: {e}")))?;
        Ok(format!("SHA256:{}", STANDARD.encode(Sha256::digest(der.as_bytes()))))
    }

    /// The login token for `user` of `account` (both as Snowflake stores them: upper case).
    pub(crate) fn jwt(&self, account: &str, user: &str, now_secs: u64) -> IdeResult<String> {
        let subject = format!("{}.{}", account.to_uppercase(), user.to_uppercase());
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = serde_json::json!({
            "iss": format!("{subject}.{}", self.fingerprint()?),
            "sub": subject,
            "iat": now_secs,
            "exp": now_secs + LIFETIME_SECS,
        });
        let message = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let signature = SigningKey::<Sha256>::new(self.key.clone())
            .try_sign(message.as_bytes())
            .map_err(|e| IdeError::internal(format!("cannot sign the login token: {e}")))?;
        Ok(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1v15::{Signature, VerifyingKey};
    use rsa::signature::Verifier;

    const PLAIN: &str = include_str!("../../tests/fixtures/snowflake/rsa_key.p8");
    const ENCRYPTED: &str = include_str!("../../tests/fixtures/snowflake/rsa_key_encrypted.p8");
    const SCRYPT: &str = include_str!("../../tests/fixtures/snowflake/rsa_key_scrypt.p8");
    const PKCS1: &str = include_str!("../../tests/fixtures/snowflake/rsa_key_pkcs1.pem");
    const LEGACY: &str = include_str!("../../tests/fixtures/snowflake/rsa_key_legacy_encrypted.pem");
    const SHORT: &str = include_str!("../../tests/fixtures/snowflake/rsa_key_1024.p8");
    const EC: &str = include_str!("../../tests/fixtures/snowflake/ec_key.p8");
    const PUBLIC: &str = include_str!("../../tests/fixtures/snowflake/rsa_key.pub");
    /// Computed with OpenSSL (see the fixtures' README).
    const FINGERPRINT: &str = "SHA256:ajjL6Bf6l1FIIyTcJli4i2AWPYDVJGQnSZr+9q9ClgI=";
    const PASSPHRASE: &str = "test-passphrase";

    fn error(pem: &str, passphrase: Option<&str>) -> IdeError {
        match parse(pem, passphrase) {
            Ok(_) => panic!("the key was accepted"),
            Err(error) => error,
        }
    }

    #[test]
    fn every_supported_format_yields_the_same_key() {
        for (pem, passphrase) in [
            (PLAIN, None),
            (PLAIN, Some("ignored")),
            (ENCRYPTED, Some(PASSPHRASE)),
            (SCRYPT, Some(PASSPHRASE)),
            (PKCS1, None),
        ] {
            assert_eq!(parse(pem, passphrase).unwrap().fingerprint().unwrap(), FINGERPRINT);
        }
        assert_eq!(parse(&format!("\n\n{PLAIN}\n\n"), None).unwrap().fingerprint().unwrap(), FINGERPRINT);
    }

    #[test]
    fn an_encrypted_key_asks_for_its_passphrase() {
        for passphrase in [None, Some("")] {
            let e = error(ENCRYPTED, passphrase);
            assert_eq!(e.kind, ErrorKind::PermissionDenied);
            assert!(e.message.contains("enter its passphrase"), "{}", e.message);
        }
    }

    #[test]
    fn a_wrong_passphrase_is_named_and_asks_again() {
        for pem in [ENCRYPTED, SCRYPT] {
            for wrong in ["wrong", "test-passphrase ", "Test-Passphrase"] {
                let e = error(pem, Some(wrong));
                assert_eq!(e.kind, ErrorKind::PermissionDenied, "{}", e.message);
                assert_eq!(e.message, "incorrect passphrase for the private key");
            }
        }
    }

    #[test]
    fn unusable_files_say_what_is_wrong() {
        let cases = [
            (LEGACY, "legacy encrypted PEM"),
            (SHORT, "1024 bits"),
            (EC, "not an RSA key"),
            (PUBLIC, "public key"),
            ("", "no PEM private key"),
            ("not a key", "no PEM private key"),
            ("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", "OpenSSH format"),
            ("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", "damaged"),
        ];
        for (pem, expected) in cases {
            let e = error(pem, Some(PASSPHRASE));
            assert_eq!(e.kind, ErrorKind::InvalidInput, "{expected}: {}", e.message);
            assert!(e.message.contains(expected), "{expected}: {}", e.message);
        }
    }

    #[test]
    fn missing_and_unreadable_files_are_reported_with_their_path() {
        let e = load("", None).err().unwrap();
        assert!(e.message.contains("select the private key file"));
        let e = load("/nonexistent/openidea/rsa_key.p8", None).err().unwrap();
        assert_eq!(e.kind, ErrorKind::InvalidInput);
        assert!(e.message.contains("/nonexistent/openidea/rsa_key.p8"), "{}", e.message);
        let dir = tempfile::tempdir().unwrap();
        let der = dir.path().join("key.der");
        std::fs::write(&der, [0x30, 0x82, 0xff, 0xfe, 0x00]).unwrap();
        let e = load(der.to_str().unwrap(), None).err().unwrap();
        assert!(e.message.contains("not a PEM file"), "{}", e.message);
        let good = dir.path().join("rsa_key.p8");
        std::fs::write(&good, ENCRYPTED).unwrap();
        assert_eq!(load(good.to_str().unwrap(), Some(PASSPHRASE)).unwrap().fingerprint().unwrap(), FINGERPRINT);
    }

    #[test]
    fn the_token_carries_snowflake_claims_and_a_valid_rs256_signature() {
        let pair = parse(PLAIN, None).unwrap();
        let token = pair.jwt("myorg-myaccount", "jane.doe@example.com", 1_700_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).unwrap();
        let header: serde_json::Value = serde_json::from_slice(&decode(parts[0])).unwrap();
        assert_eq!(header, serde_json::json!({"alg": "RS256", "typ": "JWT"}));
        let claims: serde_json::Value = serde_json::from_slice(&decode(parts[1])).unwrap();
        assert_eq!(claims["sub"], "MYORG-MYACCOUNT.JANE.DOE@EXAMPLE.COM");
        assert_eq!(claims["iss"], format!("MYORG-MYACCOUNT.JANE.DOE@EXAMPLE.COM.{FINGERPRINT}"));
        assert_eq!(claims["iat"], 1_700_000_000u64);
        assert_eq!(claims["exp"], 1_700_000_000u64 + 59 * 60);
        let verifier = VerifyingKey::<Sha256>::new(pair.key.to_public_key());
        let signature = Signature::try_from(decode(parts[2]).as_slice()).unwrap();
        verifier.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();
        assert!(verifier.verify(format!("{}.{}x", parts[0], parts[1]).as_bytes(), &signature).is_err());
    }
}
