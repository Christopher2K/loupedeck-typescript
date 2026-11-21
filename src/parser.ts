/** biome-ignore-all lint/suspicious/noAssignInExpressions: Preserve the frame-scanning loop behavior. */

import type { TransformCallback, TransformOptions } from "node:stream";
import { Transform } from "node:stream";

export interface MagicByteLengthParserOptions extends TransformOptions {
  magicByte: number;
}

// Parser to split incoming serial data by a magic byte sequence
// followed by a length
export class MagicByteLengthParser extends Transform {
  delimiter: number;
  buffer: Buffer;

  constructor({ magicByte, ...args }: MagicByteLengthParserOptions) {
    super(args);
    this.delimiter = magicByte;
    this.buffer = Buffer.alloc(0);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: TransformCallback,
  ): void {
    let data = Buffer.concat([this.buffer, chunk]);
    let position: number;
    while ((position = data.indexOf(this.delimiter)) !== -1) {
      // We need to at least be able to read the length byte
      if (data.length < position + 2) break;
      const nextLength = data[position + 1];
      // Make sure we have enough bytes to meet this length
      const expectedEnd = position + nextLength + 2;
      if (data.length < expectedEnd) break;
      this.push(data.slice(position + 2, expectedEnd));
      data = data.slice(expectedEnd);
    }
    this.buffer = data;
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    cb();
  }
}
