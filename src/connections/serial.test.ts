import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { MockSerialPort } from "../testing/mocks/serialport.js";
import type LoupedeckSerialConnection from "./serial.js";

mock.module("serialport", {
  exports: { SerialPort: MockSerialPort },
});
const { SerialPort } = await import("serialport");
const SerialConnection = (await import("./serial.js")).default;

let connection: LoupedeckSerialConnection;

describe("v0.2.X Connection", () => {
  it("auto-discovers valid connections", async () => {
    assert.deepEqual(await SerialConnection.discover(), [
      {
        kind: "node-serial",
        path: "/dev/cu.usbmodem-333",
        productId: 0x0004,
        serialNumber: "LDD12345678",
        vendorId: 0x2ec2,
      },
    ]);
  });
  it("connects via direct instantiation", async () => {
    connection = new SerialConnection({ path: "/dev/fake-path" });
    const fn = mock.fn();
    connection.on("connect", fn);
    await connection.connect();
    assert.deepEqual(fn.mock.calls[0].arguments[0], {
      address: "/dev/fake-path",
    });
    connection.close();
  });
  it("prepends small outgoing messages", async () => {
    connection = new SerialConnection();
    await connection.connect();
    assert(connection.connection);
    const sender = mock.method(connection.connection, "write");
    const TEST_MESSAGE = Buffer.from([0x88]);
    await connection.send(TEST_MESSAGE);
    assert.equal(sender.mock.calls.length, 2);
    assert.deepEqual(
      sender.mock.calls[0].arguments[0],
      Buffer.from([0x82, 0x81, 0x00, 0x00, 0x00, 0x00]),
    );
    assert.deepEqual(sender.mock.calls[1].arguments[0], TEST_MESSAGE);
    connection.close();
  });
  it("prepends large outgoing messages", async () => {
    connection = new SerialConnection();
    await connection.connect();
    assert(connection.connection);
    const sender = mock.method(connection.connection, "write");
    const TEST_MESSAGE = Buffer.alloc(4000).fill(0xff);
    await connection.send(TEST_MESSAGE);
    assert.equal(sender.mock.calls.length, 2);
    assert.deepEqual(
      sender.mock.calls[0].arguments[0],
      Buffer.from([
        0x82, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0xa0, 0x00, 0x00,
        0x00, 0x00,
      ]),
    );
    assert.deepEqual(sender.mock.calls[1].arguments[0], TEST_MESSAGE);
    connection.close();
  });
  it("serializes concurrent framed writes", async () => {
    connection = new SerialConnection();
    await connection.connect();
    assert(connection.connection);
    const sender = mock.method(connection.connection, "write");
    await Promise.all([
      connection.send(Buffer.from([1])),
      connection.send(Buffer.from([2])),
    ]);
    assert.deepEqual(
      sender.mock.calls.map((call) => call.arguments[0]),
      [
        Buffer.from([0x82, 0x81, 0, 0, 0, 0]),
        Buffer.from([1]),
        Buffer.from([0x82, 0x81, 0, 0, 0, 0]),
        Buffer.from([2]),
      ],
    );
    await connection.close();
  });
  it("reports ready to receive", async () => {
    connection = new SerialConnection();
    assert.equal(connection.isReady(), false);
    await connection.connect();
    assert.equal(connection.isReady(), true);
    connection.close();
  });
  it("reports on connection failure", async () => {
    const mockWriter = mock.method(
      SerialPort.prototype,
      "write",
      function (
        this: MockSerialPort,
        _buff: Buffer,
        callback?: (error?: Error | null) => void,
      ) {
        this.emit("data", Buffer.from("nonsense"));
        callback?.(null);
        return true;
      },
    );
    connection = new SerialConnection();
    await assert.rejects(() => connection.connect(), /Invalid handshake/i);
    mockWriter.mock.restore();
  });
  it("rejects open failures and handshake timeouts", async () => {
    connection = new SerialConnection({ path: "open-error" });
    await assert.rejects(connection.connect(), /open failed/);
    connection = new SerialConnection({ path: "no-handshake" });
    await assert.rejects(
      connection.connect({ timeoutMs: 20 }),
      /handshake timed out/i,
    );
  });
  it("closes an in-flight open without leaking a later-opened port", async () => {
    connection = new SerialConnection({ path: "slow-open" });
    const connecting = connection.connect();
    const port = connection.connection as unknown as MockSerialPort;
    await connection.close();
    await assert.rejects(connecting, /aborted/i);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(port.isOpen, false);
  });
  it("reports connection errors", async () => {
    connection = new SerialConnection();
    const disconnect = mock.fn();
    connection.on("disconnect", disconnect);
    await connection.connect();
    assert(connection.connection);
    const mockWriter = mock.method(
      connection.connection,
      "write",
      function (
        this: MockSerialPort,
        _buff: Buffer,
        callback?: (error?: Error | null) => void,
      ) {
        const error = new Error("write error");
        callback?.(error);
        this.emit("error", error);
        return true;
      },
    );
    await assert.rejects(connection.send(Buffer.from([0xff])), /write error/i);
    assert.match(disconnect.mock.calls[0].arguments[0].message, /write error/i);
    await connection.close();
    mockWriter.mock.restore();
  });
});
