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
export function fnv1a32Bytes(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) {
    h ^= byte;
    // 32-bit FNV prime (16777619) via shifts — Math.imul overflows cleanly.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
