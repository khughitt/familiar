import { writeSync } from 'node:fs';

export function writeAllSync(bytes, { write = writeSync, fd = 1 } = {}) {
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    let written;
    try {
      written = write(fd, bytes, offset, remaining);
    } catch (error) {
      if (error.code === 'EINTR') continue;
      throw error;
    }
    if (!Number.isInteger(written)) {
      throw new Error(`terminal io: write reported ${String(written)} bytes`);
    }
    if (written === 0) {
      throw new Error(`terminal io: write made zero progress with ${remaining} bytes remaining`);
    }
    if (written < 0 || written > remaining) {
      throw new Error(`terminal io: write overrun (${written} of ${remaining} bytes remaining)`);
    }
    offset += written;
  }
  return offset;
}
