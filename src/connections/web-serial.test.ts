import assert from "node:assert/strict";
import { afterEach, describe, it, type Mock, mock } from "node:test";

import { OperationAbortedError } from "../errors.js";
import {
  asSerialPort,
  MockWebSerialPort,
} from "../testing/mocks/web-serial.js";
import WebSerialConnection from "./web-serial.js";

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

function setNavigator(
  ports: MockWebSerialPort[],
  request: Mock<() => unknown> = mock.fn(),
) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serial: {
        getPorts: async () => ports.map(asSerialPort),
        requestPort: request,
      },
    },
  });
  return request;
}

describe("Web Serial", () => {
  it("lists only authorized supported ports without requesting permission", async () => {
    const supported = new MockWebSerialPort();
    const unrelated = new MockWebSerialPort(0x1234, 1);
    const request = setNavigator([supported, unrelated]);
    assert.deepEqual(await WebSerialConnection.discover(), [
      {
        kind: "web-serial",
        port: asSerialPort(supported),
        vendorId: 0x2ec2,
        productId: 4,
      },
    ]);
    assert.equal(request.mock.calls.length, 0);
  });

  it("requests permission only through request()", async () => {
    const port = new MockWebSerialPort();
    const request = mock.fn(async () => asSerialPort(port));
    setNavigator([], request);
    const descriptor = await WebSerialConnection.request();
    assert.equal(descriptor.port, asSerialPort(port));
    assert.equal(request.mock.calls.length, 1);
  });

  it("handles fragmented handshakes and preserves coalesced frames", async () => {
    const port = new MockWebSerialPort();
    port.handshakeChunks = [
      new TextEncoder().encode("HTTP/1."),
      new TextEncoder().encode("1 101 Switching Protocols\n\n"),
      Uint8Array.from([0x82, 3, 3, 0x10, 1]),
    ];
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    const message = mock.fn();
    connection.on("message", message);
    await connection.connect();
    assert(connection.isReady());
    assert.deepEqual(
      message.mock.calls[0].arguments[0],
      Uint8Array.from([3, 0x10, 1]),
    );
    await connection.close();
  });

  it("writes small and large frames in order", async () => {
    const port = new MockWebSerialPort();
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    await connection.connect();
    port.writes.length = 0;
    await connection.send(Uint8Array.from([0x88]));
    assert.deepEqual(port.writes, [
      Uint8Array.from([0x82, 0x81, 0, 0, 0, 0]),
      Uint8Array.from([0x88]),
    ]);
    port.writes.length = 0;
    await connection.send(new Uint8Array(300));
    assert.equal(port.writes.length, 2);
    assert.equal(port.writes[0]![1], 0xff);
    assert.equal(new DataView(port.writes[0]!.buffer).getUint32(6), 300);
    await connection.close();
  });

  it("serializes concurrent framed writes", async () => {
    const port = new MockWebSerialPort();
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    await connection.connect();
    port.writes.length = 0;
    await Promise.all([
      connection.send(Uint8Array.from([1])),
      connection.send(Uint8Array.from([2])),
    ]);
    assert.deepEqual(
      port.writes.map((write) => Array.from(write)),
      [[0x82, 0x81, 0, 0, 0, 0], [1], [0x82, 0x81, 0, 0, 0, 0], [2]],
    );
    await connection.close();
  });

  it("cleans up after invalid handshakes", async () => {
    const port = new MockWebSerialPort();
    port.handshakeChunks = [new TextEncoder().encode("not a device\n\n")];
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    await assert.rejects(connection.connect(), /invalid.*handshake/i);
    assert.equal(connection.isReady(), false);
    assert.equal(port.closeCalls, 1);
    await connection.close();
  });

  it("times out an incomplete handshake", async () => {
    const port = new MockWebSerialPort();
    port.handshakeChunks = [];
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    await assert.rejects(
      connection.connect({ timeoutMs: 5 }),
      /handshake timed out/i,
    );
    assert.equal(port.closeCalls, 1);
  });

  it("closes safely before, during, and after connection", async () => {
    const unused = new WebSerialConnection({
      port: asSerialPort(new MockWebSerialPort()),
    });
    await unused.close();

    const port = new MockWebSerialPort();
    port.handshakeChunks = [];
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    const connecting = connection.connect();
    await connection.close();
    await assert.rejects(connecting, OperationAbortedError);

    const connectedPort = new MockWebSerialPort();
    const connected = new WebSerialConnection({
      port: asSerialPort(connectedPort),
    });
    await connected.connect();
    await Promise.all([connected.close(), connected.close()]);
    assert.equal(connected.isReady(), false);
  });

  it("emits an Error when the read stream fails", async () => {
    const port = new MockWebSerialPort();
    const connection = new WebSerialConnection({ port: asSerialPort(port) });
    const disconnect = mock.fn();
    connection.on("disconnect", disconnect);
    await connection.connect();
    port.fail(new Error("read failed"));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (disconnect.mock.calls.length) resolve();
        else setTimeout(check, 0);
      };
      check();
    });
    assert.match(disconnect.mock.calls[0].arguments[0].message, /read failed/);
    await connection.close();
  });
});
