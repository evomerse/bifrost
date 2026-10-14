const MAX_FRAME = 16 * 1024 * 1024;

/**
 * Parses the capture helper's stdout: [u32 BE length][u16 BE width][u16 BE height][jpeg].
 * Throws on a corrupt length so the caller can restart the helper.
 */
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME) throw new Error(`corrupt frame length ${len}`);
      if (this.buf.length < 8 + len) break;
      const width = this.buf.readUInt16BE(4);
      const height = this.buf.readUInt16BE(6);
      this.onFrame(width, height, this.buf.subarray(8, 8 + len));
      this.buf = this.buf.subarray(8 + len);
    }
  }
}
