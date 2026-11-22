import type { TransformCallback, TransformOptions } from "node:stream";
import { Transform } from "node:stream";

import { MagicByteLengthDecoder } from "./frame-decoder.js";

export interface MagicByteLengthParserOptions extends TransformOptions {
  magicByte: number;
  maxBufferedBytes?: number;
}

/** Node stream adapter around the portable serial frame decoder. */
export class MagicByteLengthParser extends Transform {
  private readonly decoder: MagicByteLengthDecoder;

  constructor({
    magicByte,
    maxBufferedBytes,
    ...args
  }: MagicByteLengthParserOptions) {
    super(args);
    this.decoder = new MagicByteLengthDecoder(magicByte, maxBufferedBytes);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      for (const frame of this.decoder.push(chunk)) this.push(frame);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.decoder.finish();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}
