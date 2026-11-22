import { concatBytes } from "./bytes.js";
import { ProtocolError } from "./errors.js";

/** Portable incremental decoder for magic-byte/length-prefixed serial frames. */
export class MagicByteLengthDecoder {
  private buffer: Uint8Array = new Uint8Array();

  constructor(
    private readonly magicByte: number,
    private readonly maxBufferedBytes = 1024 * 1024,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    let data = concatBytes(this.buffer, chunk);
    const frames: Uint8Array[] = [];
    while (data.length) {
      const position = data.indexOf(this.magicByte);
      if (position === -1) {
        const last = data[data.length - 1];
        data = last === this.magicByte ? data.subarray(-1) : new Uint8Array();
        break;
      }
      if (position > 0) data = data.subarray(position);
      if (data.length < 2) break;
      const length = data[1]!;
      const end = length + 2;
      if (data.length < end) break;
      frames.push(data.subarray(2, end));
      data = data.subarray(end);
    }
    if (data.length > this.maxBufferedBytes) {
      throw new ProtocolError("Serial frame buffer exceeded its size limit");
    }
    this.buffer = data;
    return frames;
  }

  finish(): void {
    if (this.buffer.length) {
      throw new ProtocolError("Serial stream ended with an incomplete frame");
    }
  }
}
