//! OS-specific tuning seam for the native engine.
//!
//! This is the single home for platform-conditional behavior. Today that is
//! only ONNX Runtime thread selection (Android is conservative to avoid thermal
//! throttling on long saves), but future per-OS provider choices
//! (NNAPI / CoreML / DirectML / GPU) belong here too so the rest of the engine
//! stays platform-agnostic. When a second OS branch appears, promote this file
//! to a `platform/` directory with `android.rs` / `desktop.rs` siblings.

/// Default ONNX Runtime thread count for the current platform.
pub(crate) fn default_thread_count() -> i32 {
    if cfg!(target_os = "android") {
        1
    } else {
        max_thread_count().min(4)
    }
}

/// Upper bound on threads we are willing to hand ONNX Runtime.
pub(crate) fn max_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|count| count.get().clamp(1, 4) as i32)
        .unwrap_or(2)
}

/// Clamp a caller-requested thread count into the platform-safe range,
/// falling back to the platform default when unset or non-positive.
pub(crate) fn resolve_thread_count(thread_count: Option<i32>) -> i32 {
    thread_count
        .filter(|value| *value > 0)
        .unwrap_or_else(default_thread_count)
        .clamp(1, max_thread_count())
}
