import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MagicByteLengthDecoder } from "./frame-decoder.js";

describe("MagicByteLengthDecoder", () => {
  it("shares fragmented/coalesced parsing across runtimes", () => {
    const decoder = new MagicByteLengthDecoder(0x82);
    assert.deepEqual(decoder.push(Uint8Array.from([1, 2, 3])), []);
    assert.deepEqual(decoder.push(Uint8Array.from([0x82, 2, 0xaa])), []);
    const frames = decoder.push(Uint8Array.from([0xbb, 0x82, 0]));
    assert.deepEqual(frames, [Uint8Array.from([0xaa, 0xbb]), new Uint8Array()]);
  });

  it("rejects incomplete trailing frames", () => {
    const decoder = new MagicByteLengthDecoder(0x82);
    decoder.push(Uint8Array.from([0x82, 2, 0xaa]));
    assert.throws(() => decoder.finish(), /incomplete frame/i);
  });

  it("bounds buffered frames", () => {
    const decoder = new MagicByteLengthDecoder(0x82, 2);
    assert.throws(
      () => decoder.push(Uint8Array.from([0x82, 10, 1, 2, 3])),
      /size limit/i,
    );
  });
});
