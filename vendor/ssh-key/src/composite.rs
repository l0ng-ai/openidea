//! ML-DSA-44 + Ed25519 composite signature algorithm (`ssh-mldsa44-ed25519`).
//!
//! Wire-compatible with the OpenSSH 10.x implementation of
//! [draft-miller-sshm-composite-sigs], which instantiates the composite scheme of
//! [draft-ietf-lamps-pq-composite-sigs] with ML-DSA-44 ([FIPS204]) and Ed25519 ([RFC8032]).
//!
//! Keys and signatures are plain concatenations of the two halves, post-quantum first:
//!
//! ```text
//! public key  (1344) = mldsa_pk    (1312) || ed25519_pk    (32)
//! private key   (64) = mldsa_seed   (32) || ed25519_seed   (32)
//! signature   (2484) = mldsa_sig  (2420) || ed25519_sig   (64)
//! ```
//!
//! Both halves sign the same message representative `M'`, which binds a domain-separation
//! prefix, the algorithm label and the (in SSH always empty) context string to a SHA-512
//! digest of the message:
//!
//! ```text
//! M' = "CompositeAlgorithmSignatures2025" || "COMPSIG-MLDSA44-Ed25519-SHA512" || u8(0) || SHA512(msg)
//! ```
//!
//! The ML-DSA half passes the algorithm label as its own ML-DSA context string and signs
//! `M'` randomized; the Ed25519 half signs `M'` directly. A composite signature is valid
//! only if *both* halves verify, so the scheme is no weaker than its stronger half.
//!
//! [draft-miller-sshm-composite-sigs]: https://datatracker.ietf.org/doc/draft-miller-sshm-composite-sigs/
//! [draft-ietf-lamps-pq-composite-sigs]: https://datatracker.ietf.org/doc/draft-ietf-lamps-pq-composite-sigs/
//! [FIPS204]: https://csrc.nist.gov/pubs/fips/204/final
//! [RFC8032]: https://datatracker.ietf.org/doc/html/rfc8032

use crate::{Error, Result};
use alloc::vec::Vec;
use core::fmt;
use ctutils::{Choice, CtEq};
use encoding::{CheckedSum, Decode, Encode, Reader, Writer};
use ml_dsa::{
    EncodedSignature, EncodedVerifyingKey, MlDsa44, Seed, Signature as MlDsaSignature,
    SigningKey as MlDsaSigningKey, VerifyingKey as MlDsaVerifyingKey,
};
use sha2::{Digest, Sha512};
use signature::{SignatureEncoding as _, Signer as _, Verifier as _};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[cfg(feature = "rand_core")]
use rand_core::CryptoRng;

/// Domain-separation prefix shared by all composite signature algorithms.
const PREFIX: &[u8] = b"CompositeAlgorithmSignatures2025";

/// Algorithm label, also used as the ML-DSA context string of the post-quantum half.
const LABEL: &[u8] = b"COMPSIG-MLDSA44-Ed25519-SHA512";

/// Size of an encoded ML-DSA-44 public key in bytes.
const MLDSA44_PUBLIC_KEY_SIZE: usize = 1312;

/// Size of an encoded ML-DSA-44 signature in bytes.
const MLDSA44_SIGNATURE_SIZE: usize = 2420;

/// Size of an ML-DSA-44 key generation seed in bytes.
const MLDSA44_SEED_SIZE: usize = 32;

/// Size of an Ed25519 public key in bytes.
const ED25519_PUBLIC_KEY_SIZE: usize = 32;

/// Size of an Ed25519 signature in bytes.
const ED25519_SIGNATURE_SIZE: usize = 64;

/// Size of an Ed25519 key generation seed in bytes.
const ED25519_SEED_SIZE: usize = 32;

/// Computes the composite message representative `M'` over the message.
fn m_prime(message: &[u8]) -> Vec<u8> {
    let mut m_prime = Vec::with_capacity(PREFIX.len() + LABEL.len() + 1 + 64);
    m_prime.extend_from_slice(PREFIX);
    m_prime.extend_from_slice(LABEL);
    m_prime.push(0);
    m_prime.extend_from_slice(Sha512::digest(message).as_slice());
    m_prime
}

/// ML-DSA-44 + Ed25519 composite public key.
///
/// Encoded as `mldsa_pk (1312) || ed25519_pk (32)` in a single SSH `string`.
#[derive(Copy, Clone, Debug, Eq, Hash, PartialEq, PartialOrd, Ord)]
pub struct MlDsa44Ed25519PublicKey(pub [u8; Self::BYTE_SIZE]);

impl MlDsa44Ed25519PublicKey {
    /// Size of a composite public key in bytes.
    pub const BYTE_SIZE: usize = MLDSA44_PUBLIC_KEY_SIZE + ED25519_PUBLIC_KEY_SIZE;

    /// Size of a composite signature in bytes.
    pub const SIGNATURE_SIZE: usize = MLDSA44_SIGNATURE_SIZE + ED25519_SIGNATURE_SIZE;

    /// Verify a composite signature over the message: both halves must verify.
    ///
    /// # Errors
    /// Returns [`Error::Crypto`] if the signature is malformed or either half fails to
    /// verify.
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> Result<()> {
        if signature.len() != Self::SIGNATURE_SIZE {
            return Err(encoding::Error::Length.into());
        }

        let m_prime = m_prime(message);

        let mldsa_enc = EncodedVerifyingKey::<MlDsa44>::try_from(&self.0[..MLDSA44_PUBLIC_KEY_SIZE])
            .map_err(|_| Error::Crypto)?;
        let mldsa_sig_enc =
            EncodedSignature::<MlDsa44>::try_from(&signature[..MLDSA44_SIGNATURE_SIZE])
                .map_err(|_| Error::Crypto)?;
        let mldsa_sig = MlDsaSignature::<MlDsa44>::decode(&mldsa_sig_enc).ok_or(Error::Crypto)?;
        if !MlDsaVerifyingKey::<MlDsa44>::decode(&mldsa_enc).verify_with_context(
            &m_prime,
            LABEL,
            &mldsa_sig,
        ) {
            return Err(Error::Crypto);
        }

        let ed25519_sig = ed25519_dalek::Signature::try_from(&signature[MLDSA44_SIGNATURE_SIZE..])
            .map_err(|_| Error::Crypto)?;
        let ed25519_vk = ed25519_dalek::VerifyingKey::from_bytes(
            self.0[MLDSA44_PUBLIC_KEY_SIZE..]
                .try_into()
                .map_err(|_| Error::Crypto)?,
        )
        .map_err(|_| Error::Crypto)?;
        ed25519_vk
            .verify(&m_prime, &ed25519_sig)
            .map_err(|_| Error::Crypto)
    }
}

impl AsRef<[u8; Self::BYTE_SIZE]> for MlDsa44Ed25519PublicKey {
    fn as_ref(&self) -> &[u8; Self::BYTE_SIZE] {
        &self.0
    }
}

impl Decode for MlDsa44Ed25519PublicKey {
    type Error = Error;

    fn decode(reader: &mut impl Reader) -> Result<Self> {
        let mut bytes = [0u8; Self::BYTE_SIZE];
        reader.read_prefixed(|reader| reader.read(&mut bytes))?;
        Ok(Self(bytes))
    }
}

impl Encode for MlDsa44Ed25519PublicKey {
    fn encoded_len(&self) -> encoding::Result<usize> {
        [4, Self::BYTE_SIZE].checked_sum()
    }

    fn encode(&self, writer: &mut impl Writer) -> encoding::Result<()> {
        self.0.as_slice().encode(writer)?;
        Ok(())
    }
}

impl TryFrom<&[u8]> for MlDsa44Ed25519PublicKey {
    type Error = Error;

    fn try_from(bytes: &[u8]) -> Result<Self> {
        Ok(Self(bytes.try_into()?))
    }
}

impl fmt::Display for MlDsa44Ed25519PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:X}")
    }
}

impl fmt::LowerHex for MlDsa44Ed25519PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.as_ref() {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl fmt::UpperHex for MlDsa44Ed25519PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.as_ref() {
            write!(f, "{byte:02X}")?;
        }
        Ok(())
    }
}

impl CtEq for MlDsa44Ed25519PublicKey {
    fn ct_eq(&self, other: &Self) -> Choice {
        self.as_ref().ct_eq(other.as_ref())
    }
}

/// ML-DSA-44 + Ed25519 composite private key.
///
/// Seed representation: `mldsa_seed (32) || ed25519_seed (32)`; both halves are re-expanded
/// on demand.
#[derive(Clone)]
pub struct MlDsa44Ed25519PrivateKey(pub [u8; Self::BYTE_SIZE]);

impl MlDsa44Ed25519PrivateKey {
    /// Size of a composite private key in bytes.
    pub const BYTE_SIZE: usize = MLDSA44_SEED_SIZE + ED25519_SEED_SIZE;
}

impl Drop for MlDsa44Ed25519PrivateKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for MlDsa44Ed25519PrivateKey {}

impl AsRef<[u8; Self::BYTE_SIZE]> for MlDsa44Ed25519PrivateKey {
    fn as_ref(&self) -> &[u8; Self::BYTE_SIZE] {
        &self.0
    }
}

impl CtEq for MlDsa44Ed25519PrivateKey {
    fn ct_eq(&self, other: &Self) -> Choice {
        self.as_ref().ct_eq(other.as_ref())
    }
}

impl Eq for MlDsa44Ed25519PrivateKey {}

impl PartialEq for MlDsa44Ed25519PrivateKey {
    fn eq(&self, other: &Self) -> bool {
        self.ct_eq(other).into()
    }
}

impl fmt::Debug for MlDsa44Ed25519PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MlDsa44Ed25519PrivateKey").finish_non_exhaustive()
    }
}

impl fmt::LowerHex for MlDsa44Ed25519PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.as_ref() {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl fmt::UpperHex for MlDsa44Ed25519PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.as_ref() {
            write!(f, "{byte:02X}")?;
        }
        Ok(())
    }
}

/// ML-DSA-44 + Ed25519 composite private/public keypair.
#[derive(Clone)]
pub struct MlDsa44Ed25519Keypair {
    /// Public key.
    pub public: MlDsa44Ed25519PublicKey,

    /// Private key.
    pub private: MlDsa44Ed25519PrivateKey,
}

impl MlDsa44Ed25519Keypair {
    /// Size of a composite keypair in bytes.
    pub const BYTE_SIZE: usize =
        MlDsa44Ed25519PublicKey::BYTE_SIZE + MlDsa44Ed25519PrivateKey::BYTE_SIZE;

    /// Generate a random composite keypair.
    #[cfg(feature = "rand_core")]
    pub fn random<R: CryptoRng + ?Sized>(rng: &mut R) -> Self {
        let mut private = MlDsa44Ed25519PrivateKey([0u8; MlDsa44Ed25519PrivateKey::BYTE_SIZE]);
        rng.fill_bytes(&mut private.0);
        Self::from_private(&private).expect("random seed expands")
    }

    /// Expand a composite keypair from its private key (seed pair).
    ///
    /// # Errors
    /// Returns [`Error::Crypto`] if the ML-DSA half fails to expand.
    pub fn from_private(private: &MlDsa44Ed25519PrivateKey) -> Result<Self> {
        let mldsa_seed =
            Seed::try_from(&private.0[..MLDSA44_SEED_SIZE]).map_err(|_| Error::Crypto)?;
        let mldsa_public = MlDsaSigningKey::<MlDsa44>::from_seed(&mldsa_seed)
            .expanded_key()
            .verifying_key()
            .encode();

        let mut ed25519_seed = [0u8; ED25519_SEED_SIZE];
        ed25519_seed.copy_from_slice(&private.0[MLDSA44_SEED_SIZE..]);
        let ed25519_public = ed25519_dalek::SigningKey::from_bytes(&ed25519_seed)
            .verifying_key()
            .to_bytes();
        ed25519_seed.zeroize();

        let mut bytes = [0u8; MlDsa44Ed25519PublicKey::BYTE_SIZE];
        bytes[..MLDSA44_PUBLIC_KEY_SIZE].copy_from_slice(mldsa_public.as_slice());
        bytes[MLDSA44_PUBLIC_KEY_SIZE..].copy_from_slice(&ed25519_public);

        Ok(Self {
            public: MlDsa44Ed25519PublicKey(bytes),
            private: private.clone(),
        })
    }

    /// Sign the message with the composite scheme, using randomized ML-DSA.
    ///
    /// # Errors
    /// Returns [`Error::Crypto`] if either half fails to sign.
    #[cfg(feature = "rand_core")]
    pub fn sign<R: CryptoRng + ?Sized>(&self, rng: &mut R, message: &[u8]) -> Result<Vec<u8>> {
        let m_prime = m_prime(message);

        let mldsa_seed =
            Seed::try_from(&self.private.0[..MLDSA44_SEED_SIZE]).map_err(|_| Error::Crypto)?;
        let mldsa_sig = MlDsaSigningKey::<MlDsa44>::from_seed(&mldsa_seed)
            .expanded_key()
            .sign_randomized(&m_prime, LABEL, rng)
            .map_err(|_| Error::Crypto)?
            .encode();

        Ok(self.finish_signature(&m_prime, &mldsa_sig))
    }

    /// Sign the message with the composite scheme, using deterministic ML-DSA.
    ///
    /// # Errors
    /// Returns [`Error::Crypto`] if either half fails to sign.
    pub fn sign_deterministic(&self, message: &[u8]) -> Result<Vec<u8>> {
        let m_prime = m_prime(message);

        let mldsa_seed =
            Seed::try_from(&self.private.0[..MLDSA44_SEED_SIZE]).map_err(|_| Error::Crypto)?;
        let mldsa_sig = MlDsaSigningKey::<MlDsa44>::from_seed(&mldsa_seed)
            .expanded_key()
            .sign_deterministic(&m_prime, LABEL)
            .map_err(|_| Error::Crypto)?
            .encode();

        Ok(self.finish_signature(&m_prime, &mldsa_sig))
    }

    fn finish_signature(&self, m_prime: &[u8], mldsa_sig: &EncodedSignature<MlDsa44>) -> Vec<u8> {
        let mut ed25519_seed = [0u8; ED25519_SEED_SIZE];
        ed25519_seed.copy_from_slice(&self.private.0[MLDSA44_SEED_SIZE..]);
        let ed25519_sig = ed25519_dalek::SigningKey::from_bytes(&ed25519_seed)
            .sign(m_prime)
            .to_vec();
        ed25519_seed.zeroize();

        let mut signature = Vec::with_capacity(MlDsa44Ed25519PublicKey::SIGNATURE_SIZE);
        signature.extend_from_slice(mldsa_sig.as_slice());
        signature.extend_from_slice(&ed25519_sig);
        signature
    }
}

impl Decode for MlDsa44Ed25519Keypair {
    type Error = Error;

    fn decode(reader: &mut impl Reader) -> Result<Self> {
        let public = MlDsa44Ed25519PublicKey::decode(reader)?;
        let mut private = MlDsa44Ed25519PrivateKey([0u8; MlDsa44Ed25519PrivateKey::BYTE_SIZE]);
        reader.read_prefixed(|reader| reader.read(&mut private.0))?;
        let keypair = Self::from_private(&private)?;
        if keypair.public != public {
            return Err(Error::Crypto);
        }
        Ok(keypair)
    }
}

impl Encode for MlDsa44Ed25519Keypair {
    fn encoded_len(&self) -> encoding::Result<usize> {
        [
            self.public.encoded_len()?,
            4 + MlDsa44Ed25519PrivateKey::BYTE_SIZE,
        ]
        .checked_sum()
    }

    fn encode(&self, writer: &mut impl Writer) -> encoding::Result<()> {
        self.public.encode(writer)?;
        self.private.0.as_slice().encode(writer)?;
        Ok(())
    }
}

impl fmt::Debug for MlDsa44Ed25519Keypair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MlDsa44Ed25519Keypair")
            .field("public", &self.public)
            .finish_non_exhaustive()
    }
}

impl From<&MlDsa44Ed25519Keypair> for MlDsa44Ed25519PublicKey {
    fn from(keypair: &MlDsa44Ed25519Keypair) -> MlDsa44Ed25519PublicKey {
        keypair.public
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chacha20::rand_core::SeedableRng;

    #[test]
    fn round_trip_sign_verify() {
        let keypair = MlDsa44Ed25519Keypair::random(&mut chacha20::ChaCha8Rng::from_seed([7u8; 32]));
        let message = b"hello composite world";

        let signature = keypair
            .sign(&mut chacha20::ChaCha8Rng::from_seed([8u8; 32]), message)
            .unwrap();
        assert_eq!(signature.len(), MlDsa44Ed25519PublicKey::SIGNATURE_SIZE);
        keypair.public.verify(message, &signature).unwrap();

        let mut tampered = signature.clone();
        tampered[0] ^= 1;
        assert!(keypair.public.verify(message, &tampered).is_err());

        let mut tampered = signature.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(keypair.public.verify(message, &tampered).is_err());

        let mut other = *message;
        other[0] ^= 1;
        assert!(keypair.public.verify(&other, &signature).is_err());
    }
}
