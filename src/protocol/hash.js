// FNV-1a, 32-bit, over UTF-8 bytes. FROZEN: this function decides which
// character every unpinned project gets. Changing it reshuffles them all.
export function fnv1a32(str) {
  return fnv1a32Bytes(new TextEncoder().encode(str));
}

// Same algorithm, applied directly to raw bytes (a Buffer/Uint8Array) instead
// of a UTF-8-encoded string. This is an ADDITION alongside the frozen
// fnv1a32, not a change to it — fnv1a32 still does exactly what it did,
// via this shared loop. It exists because hashing arbitrary binary content
// (a PNG's bytes, say) by calling `fnv1a32(buffer.toString(...))` would
// round-trip those bytes through a text codec first, which is lossy for
// anything that isn't valid UTF-8. This skips that entirely.
// The seed is an ADDITION for chaining: hashing several byte runs in sequence
// without allocating a joined buffer. Its default is the FNV offset basis, so a
// one-argument call is byte-identical to what it always did -- which matters,
// because fnv1a32 above is frozen.
export function fnv1a32Bytes(bytes, seed = 0x811c9dc5) {
  let h = seed;
  for (const byte of bytes) {
    h ^= byte;
    // 32-bit FNV prime (16777619) via shifts — Math.imul overflows cleanly.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
