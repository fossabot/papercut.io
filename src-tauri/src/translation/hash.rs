//! Stable non-cryptographic hashing for translation cache identity.
//!
//! Cache keys, segment memory keys, and stored provenance hashes must not
//! change across Rust releases, so `std::hash::DefaultHasher` (algorithm
//! unspecified) is not suitable. This FNV-1a variant is the single shared
//! implementation; length prefixes keep multi-part keys unambiguous.

pub(crate) struct StableHasher(u64);

impl StableHasher {
    pub(crate) fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    pub(crate) fn write_str(&mut self, value: &str) {
        for byte in value.len().to_le_bytes().into_iter().chain(value.bytes()) {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    pub(crate) fn finish_hex(self) -> String {
        format!("{:016x}", self.0)
    }
}

/// Hash one text value into the shared 16-hex-digit key format.
pub(crate) fn stable_text_hash(text: &str) -> String {
    let mut hasher = StableHasher::new();
    hasher.write_str(text);
    hasher.finish_hex()
}

#[cfg(test)]
mod tests {
    use super::{stable_text_hash, StableHasher};

    #[test]
    fn text_hash_is_stable_and_distinct() {
        assert_eq!(stable_text_hash("uno"), stable_text_hash("uno"));
        assert_ne!(stable_text_hash("uno"), stable_text_hash("dos"));
    }

    #[test]
    fn length_prefix_separates_part_boundaries() {
        let mut joined = StableHasher::new();
        joined.write_str("ab");
        joined.write_str("c");
        let mut shifted = StableHasher::new();
        shifted.write_str("a");
        shifted.write_str("bc");

        assert_ne!(joined.finish_hex(), shifted.finish_hex());
    }
}
