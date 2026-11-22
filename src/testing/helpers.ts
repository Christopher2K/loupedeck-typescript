import assert from "node:assert/strict";

import { readUint16BE } from "../bytes.js";
import type { LoupedeckDevice } from "../device.js";
import type { DeviceTransport } from "../transport.js";
import type { PacketResponse } from "../types.js";

interface PixelBufferExpectation {
  displayID: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function assertIsPixelBuffer(
  received: Uint8Array,
  { displayID, x, y, width, height }: PixelBufferExpectation,
): void {
  assert(
    readUint16BE(received, 0) === 0xff10,
    `Header should be 0xff10, found 0x${readUint16BE(received, 0).toString(16)}`,
  );
  assert.equal(readUint16BE(received, 3), displayID, "Display ID");
  assert.equal(readUint16BE(received, 5), x, "X coordinate");
  assert.equal(readUint16BE(received, 7), y, "Y coordinate");
  assert.equal(readUint16BE(received, 9), width, "Width");
  assert.equal(readUint16BE(received, 11), height, "Height");
  assert.equal(received.length, 13 + width * height * 2, "Buffer length");
}

export function bytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

interface DeviceInternals {
  connection: DeviceTransport | null | undefined;
  onReceive(packet: Uint8Array): PacketResponse;
  generation: number;
  handleDisconnect(error: Error | undefined, generation: number): void;
}

function internals(device: LoupedeckDevice): DeviceInternals {
  return device as unknown as DeviceInternals;
}

export function setMockConnection(
  device: LoupedeckDevice,
  isReady = true,
): void {
  internals(device).connection = {
    close: () => Promise.resolve(),
    connect: () => Promise.resolve(),
    on: () => undefined,
    send: (packet: Uint8Array) => {
      const command = packet[1]!;
      if (command === 0x03 || command === 0x07) return Promise.resolve();
      queueMicrotask(() => {
        receivePacket(device, Uint8Array.from([3, command, packet[2]!]));
      });
      return Promise.resolve();
    },
    isReady: () => isReady,
  };
}

export function getMockConnection(device: LoupedeckDevice): DeviceTransport {
  const connection = internals(device).connection;
  assert(connection);
  return connection;
}

export function receivePacket(
  device: LoupedeckDevice,
  packet: Uint8Array,
): PacketResponse {
  return internals(device).onReceive(packet);
}

export function disconnectMockDevice(
  device: LoupedeckDevice,
  error?: Error,
): void {
  const internal = internals(device);
  internal.handleDisconnect(error, internal.generation);
}

export const delay = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));
