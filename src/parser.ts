/** biome-ignore-all lint/suspicious/noAssignInExpressions: Preserve the frame-scanning loop behavior. */

import type { TransformCallback, TransformOptions } from "node:stream";
import { Transform } from "node:stream";

/** Options for {@link MagicByteLengthParser}. */
export interface MagicByteLengthParserOptions extends TransformOptions {
  /** Byte value marking the start of each frame. */
  magicByte: number;
}

/**
 * Node.js transform stream that extracts length-prefixed payloads from binary
 * serial data.
 *
 * Each frame starts with the configured magic byte followed by an unsigned
 * one-byte payload length. The transform emits only the payload bytes. It
 * buffers incomplete frames across chunks, supports multiple frames per chunk,
 * and discards bytes preceding a delimiter once that frame is emitted.
 */
export class MagicByteLengthParser extends Transform {
  /** Byte value that marks the start of a frame. */
  delimiter: number;
  /** Bytes retained because no complete frame has yet been parsed. */
  buffer: Buffer;

  /**
   * Creates a transform with an empty internal frame buffer.
   *
   * @param options - The magic byte and standard Node.js transform options.
   * The remaining transform options are forwarded to `Transform`.
   */
  constructor({ magicByte, ...args }: MagicByteLengthParserOptions) {
    super(args);
    this.delimiter = magicByte;
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Combines a chunk with buffered bytes and pushes each complete frame's
   * payload, retaining any incomplete trailing frame for the next chunk.
   *
   * @param chunk - Next bytes received from the upstream stream.
   * @param _encoding - Chunk encoding; unused for binary input.
   * @param cb - Callback invoked after the chunk has been processed.
   */
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

  /**
   * Pushes any remaining buffered bytes at end of input, including an
   * incomplete or unframed trailing sequence, and clears the buffer.
   *
   * @param cb - Callback invoked after the final buffered data is pushed.
   */
  override _flush(cb: TransformCallback): void {
    this.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    cb();
  }
}
