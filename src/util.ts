import { InvalidArgumentError } from "./errors.js";

/** Convert RGBA pixels to little-endian RGB565 bytes. */
export function rgba2rgb565(
  rgba: ArrayLike<number>,
  pixelSize = rgba.length / 4,
): Uint8Array {
  if (
    !Number.isInteger(pixelSize) ||
    pixelSize < 0 ||
    rgba.length !== pixelSize * 4
  ) {
    throw new InvalidArgumentError(
      "RGBA input must contain four values per pixel",
    );
  }
  const output = new Uint8Array(pixelSize * 2);
  for (let index = 0; index < pixelSize * 4; index += 4) {
    const red = rgba[index]!;
    const green = rgba[index + 1]!;
    const blue = rgba[index + 2]!;
    const color = (blue >> 3) | ((green & 0xfc) << 3) | ((red & 0xf8) << 8);
    const offset = index / 2;
    output[offset] = color & 0xff;
    output[offset + 1] = (color >>> 8) & 0xff;
  }
  return output;
}
