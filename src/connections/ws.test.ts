import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, it, mock } from "node:test";

import { MockSocket } from "../testing/mocks/ws.js";
import type LoupedeckWSConnection from "./ws.js";

const networkInterfaces = mock.fn<() => NodeJS.Dict<NetworkInterfaceInfo[]>>();
mock.module("ws", { exports: { default: MockSocket } });
mock.module("node:os", { exports: { networkInterfaces } });
const WSConnection = (await import("./ws.js")).default;

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

let connection: LoupedeckWSConnection;

describe("v0.1.X Connection", () => {
  it("auto-discovers valid connections", async () => {
    networkInterfaces.mock.mockImplementationOnce(() => ({
      test: [
        {
          address: "255.255.255.255",
          family: "IPv4",
          netmask: "",
          mac: "",
          internal: false,
          cidr: null,
        },
      ],
    }));
    assert.deepEqual(await WSConnection.discover(), []);
    networkInterfaces.mock.mockImplementationOnce(() => ({
      test: [
        {
          address: "100.127.80.1",
          family: "IPv4",
          netmask: "",
          mac: "",
          internal: false,
          cidr: null,
        },
      ],
    }));
    assert.deepEqual(await WSConnection.discover(), [
      {
        kind: "websocket",
        host: "100.127.80.1",
        productId: 4,
        vendorId: 0x2ec2,
      },
    ]);
  });
  it("connects via direct instantiation", async () => {
    connection = new WSConnection({ host: "127.0.0.1" });
    const fn = mock.fn();
    connection.on("connect", fn);
    await connection.connect();
    assert.deepEqual(fn.mock.calls[0].arguments[0], {
      address: "ws://127.0.0.1",
    });
    connection.close();
  });
  it("rejects refused connections", async () => {
    connection = new WSConnection({ host: "refused" });
    await assert.rejects(connection.connect({ timeoutMs: 50 }), /ECONNREFUSED/);
  });
  it("keeps connection alive when ticks received", async () => {
    connection = new WSConnection();
    const fn = mock.fn();
    connection.on("disconnect", fn);
    connection.connectionTimeout = 20;
    const connect = mock.method(connection, "connect");
    await connection.connect();
    for (let i = 0; i < 8; i++) {
      await delay(10);
      connection.onReceive();
    }
    assert.equal(fn.mock.calls.length, 0);
    assert.equal(connect.mock.calls.length, 1);
  });
  it("disconnects on timeout", async () => {
    connection = new WSConnection();
    const keepAliveCheck = mock.method(connection, "checkConnected");
    const fn = mock.fn();
    connection.on("disconnect", fn);
    connection.connectionTimeout = 20;
    await connection.connect();
    await delay(80);
    assert.match(fn.mock.calls[0].arguments[0].message, /1006/);
    assert(keepAliveCheck.mock.calls.length >= 1);
  });
  it("delegates messages", async () => {
    connection = new WSConnection();
    await connection.connect();
    assert(connection.connection);
    const sender = mock.method(connection.connection, "send");
    const TEST_MESSAGE = Buffer.from([0x88]);
    await connection.send(TEST_MESSAGE);
    assert.equal(sender.mock.calls[0].arguments[0], TEST_MESSAGE);
    connection.close();
  });
  it("reports ready to receive", async () => {
    connection = new WSConnection();
    assert.equal(connection.isReady(), false);
    await connection.connect();
    assert.equal(connection.isReady(), true);
    connection.close();
  });
  it("can close even when not connected", () => {
    connection = new WSConnection();
    connection.close();
    assert.equal(connection.connection, undefined);
  });
});
