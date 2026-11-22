export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function readInt8(data: Uint8Array, offset: number): number {
  return (data[offset]! << 24) >> 24;
}

export function readUint16BE(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

export function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  );
}

export function writeUint16BE(
  data: Uint8Array,
  value: number,
  offset: number,
): void {
  data[offset] = (value >>> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

export function writeUint32BE(
  data: Uint8Array,
  value: number,
  offset: number,
): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

export function swap16(data: Uint8Array): void {
  for (let index = 0; index + 1 < data.length; index += 2) {
    const first = data[index]!;
    data[index] = data[index + 1]!;
    data[index + 1] = first;
  }
}
