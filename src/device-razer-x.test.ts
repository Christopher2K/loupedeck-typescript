import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import {
  assertIsPixelBuffer,
  bytesFromHex,
  delay,
  getMockConnection,
  receivePacket,
  setMockConnection,
  toHex,
} from "./testing/helpers.js";
import { MockSerialPort } from "./testing/mocks/serialport.js";
import { MockSocket } from "./testing/mocks/ws.js";

mock.module("ws", { exports: { default: MockSocket } });
mock.module("serialport", {
  exports: { SerialPort: MockSerialPort },
});

import { type ControlId, RazerStreamControllerX } from "./index.js";

let device: RazerStreamControllerX;

describe("Commands", () => {
  beforeEach(() => {
    device = new RazerStreamControllerX({ autoConnect: false });
    setMockConnection(device);
  });
  it("retrieves device information", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    const promise = device.getInfo();
    assert.deepEqual(sender.mock.calls[0].arguments[0], bytesFromHex("030301"));
    receivePacket(
      device,
      Buffer.from(
        "1f03015055323532344c303637303032313020202020202020202020202020",
        "hex",
      ),
    );
    await delay(20);
    assert.deepEqual(sender.mock.calls[1].arguments[0], bytesFromHex("030702"));
    receivePacket(device, bytesFromHex("0c0702000217000000000000"));
    assert.deepEqual(await promise, {
      version: "0.2.23",
      serial: "PU2524L06700210",
    });
  });
  it("rejects retrieving device information if not connected", async () => {
    setMockConnection(device, false);
    const promise = device.getInfo();
    await assert.rejects(promise, /not connected/i);
  });
  it("sets brightness", () => {
    const sender = mock.method(getMockConnection(device), "send");
    device.setBrightness(0);
    assert.deepEqual(
      sender.mock.calls[0].arguments[0],
      bytesFromHex("04090100"),
    );
    device.setBrightness(1);
    // 0x0b should be max brightness
    assert.deepEqual(
      sender.mock.calls[1].arguments[0],
      bytesFromHex("0409020a"),
    );
  });
  it("cannot set button color", async () => {
    await assert.rejects(
      device.setButtonColor({ id: "triangle" as ControlId, color: "blue" }),
      /Button colors is not available/,
    );
  });
  it("cannot vibrate", async () => {
    await assert.rejects(device.vibrate(), /Vibration is not available/);
  });
  it("emits a `touchstart` and a `down` event when a key is pressed", () => {
    const touchListener = mock.fn();
    const downListener = mock.fn();
    device.on("touchstart", touchListener);
    device.on("down", downListener);
    receivePacket(device, bytesFromHex("0500002900"));
    assert.deepEqual(downListener.mock.calls[0].arguments[0], { id: 14 });
    assert.deepEqual(touchListener.mock.calls[0].arguments[0], {
      touches: [
        { id: 15, x: 4.5 * 96, y: 2.5 * 96, target: { kind: "key", key: 14 } },
      ],
      changedTouches: [
        { id: 15, x: 4.5 * 96, y: 2.5 * 96, target: { kind: "key", key: 14 } },
      ],
    });
  });
  it("tracks simultaneous synthetic key touches", () => {
    const touchstart = mock.fn();
    const touchend = mock.fn();
    device.on("touchstart", touchstart);
    device.on("touchend", touchend);
    receivePacket(device, bytesFromHex("0500001b00"));
    receivePacket(device, bytesFromHex("0500001c00"));
    assert.equal(touchstart.mock.calls[1].arguments[0].touches.length, 2);
    receivePacket(device, bytesFromHex("0500001b01"));
    assert.deepEqual(
      touchend.mock.calls[0].arguments[0].touches.map(
        (touch: { id: number }) => touch.id,
      ),
      [2],
    );
  });
});
describe("Drawing (Callback API)", () => {
  beforeEach(() => {
    device = new RazerStreamControllerX({ autoConnect: false });
    setMockConnection(device);
  });
  it("writes pixels to main display", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    await device.drawScreen("center", (ctx, w, h) => {
      ctx.fillStyle = "#00f"; // blue
      ctx.fillRect(0, 0, w, h);
    });
    // Color format is 5-6-5 16-bit RGB
    // so last 5 bits for full blue is 0x001f, or 0x1f00 in LE
    const pixels = "1f00".repeat(480 * 288);
    assertIsPixelBuffer(sender.mock.calls[0].arguments[0], {
      displayID: 0x004d,
      x: 0,
      y: 0,
      width: 480,
      height: 288,
    });
    assert.equal(toHex(sender.mock.calls[0].arguments[0].subarray(13)), pixels);
    // Confirm write
    receivePacket(device, bytesFromHex("031001"));
    await delay(10);
    assert.deepEqual(
      sender.mock.calls[1].arguments[0],
      bytesFromHex("050f02004d"),
    );
  });
  it("writes pixels to a specific key area", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    await device.drawKey(6, (ctx, w, h) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
    });
    const pixels = "ffff".repeat(96 * 96);
    assertIsPixelBuffer(sender.mock.calls[0].arguments[0], {
      displayID: 0x004d,
      x: 96,
      y: 96,
      width: 96,
      height: 96,
    });
    assert.equal(toHex(sender.mock.calls[0].arguments[0].subarray(13)), pixels);
    // Confirm write
    receivePacket(device, bytesFromHex("031001"));
    await delay(10);
    assert.deepEqual(
      sender.mock.calls[1].arguments[0],
      bytesFromHex("050f02004d"),
    );
  });
  it("writes pixels without refreshing the screen", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    await device.drawCanvas(
      { id: "center", width: 10, height: 10, autoRefresh: false },
      () => {},
    );
    // Confirm write
    receivePacket(device, bytesFromHex("031001"));
    await delay(10);
    assert.equal(sender.mock.calls.length, 1);
  });
});
describe("Drawing (Buffer API)", () => {
  beforeEach(() => {
    device = new RazerStreamControllerX({ autoConnect: false });
    setMockConnection(device);
  });
  it("writes pixels to center display", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    const pixels = Array(480 * 288).fill([0x1f, 0x00]);
    const buffer = Buffer.from(pixels.flat());
    await device.drawScreen("center", buffer);
    // Color format is 5-6-5 16-bit RGB
    // so last 5 bits for full blue is 0x001f, or 0x1f00 in LE
    const hex = "1f00".repeat(480 * 288);
    assertIsPixelBuffer(sender.mock.calls[0].arguments[0], {
      displayID: 0x004d,
      x: 0,
      y: 0,
      width: 480,
      height: 288,
    });
    assert.equal(toHex(sender.mock.calls[0].arguments[0].subarray(13)), hex);
    // Confirm write
    receivePacket(device, bytesFromHex("031001"));
    await delay(10);
    assert.deepEqual(
      sender.mock.calls[1].arguments[0],
      bytesFromHex("050f02004d"),
    );
  });
  it("writes pixels to a specific key area", async () => {
    const sender = mock.method(getMockConnection(device), "send");
    const pixels = Array(96 * 96 * 2).fill(0xff);
    const buffer = Buffer.from(pixels);
    await device.drawKey(6, buffer);
    const hex = "ffff".repeat(96 * 96);
    assertIsPixelBuffer(sender.mock.calls[0].arguments[0], {
      displayID: 0x004d,
      x: 96,
      y: 96,
      width: 96,
      height: 96,
    });
    assert.equal(toHex(sender.mock.calls[0].arguments[0].subarray(13)), hex);
    // Confirm write
    receivePacket(device, bytesFromHex("031001"));
    await delay(10);
    assert.deepEqual(
      sender.mock.calls[1].arguments[0],
      bytesFromHex("050f02004d"),
    );
  });
  it("reports an error if the buffer is the wrong size", async () => {
    const pixels = Array(30).fill(0xff);
    const buffer = Buffer.from(pixels);
    await assert.rejects(
      device.drawScreen("center", buffer),
      /expected buffer length of 276480, got 30/i,
    );
  });
});
