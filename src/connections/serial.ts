import { SerialPort } from "serialport";
import { Emitter as EventEmitter } from "strict-event-emitter";

import {
  asError,
  ConnectionTimeoutError,
  NotConnectedError,
  OperationAbortedError,
  ProtocolError,
} from "../errors.js";
import { MagicByteLengthParser } from "../parser.js";
import type {
  SerialConnectionInfo,
  TransportConnectOptions,
} from "../transport.js";

const WS_UPGRADE_HEADER = `GET /index.html
HTTP/1.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: 123abc

`;
const WS_UPGRADE_RESPONSE = "HTTP/1.1";
const WS_CLOSE_FRAME = [0x88, 0x80, 0x00, 0x00, 0x00, 0x00];
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const MAX_HANDSHAKE_BYTES = 16 * 1024;

const VENDOR_IDS = [
  0x2ec2, // Loupedeck
  0x1532, // Razer
];
const MANUFACTURERS = ["Loupedeck", "Razer"];

export type {
  SerialConnectionInfo,
  TransportConnectOptions,
} from "../transport.js";

/** Events emitted by a {@link LoupedeckSerialConnection}. */
export type SerialConnectionEvents = {
  connect: [info: { address: string | undefined }];
  message: [data: Uint8Array];
  disconnect: [error: Error | undefined];
};

/** Options for creating a serial connection. */
export interface SerialConnectionOptions {
  path?: string;
}

/** Node serial transport, including the device's HTTP upgrade handshake. */
export default class LoupedeckSerialConnection extends EventEmitter<SerialConnectionEvents> {
  path: string | undefined;
  connection: SerialPort | undefined;

  private connected = false;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private connectionAbort: AbortController | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor({ path }: SerialConnectionOptions = {}) {
    super();
    this.path = path;
  }

  /** List Loupedeck/Razer serial ports without opening them. */
  static async discover(): Promise<SerialConnectionInfo[]> {
    const results: SerialConnectionInfo[] = [];
    for (const info of await SerialPort.list()) {
      const { manufacturer, path, serialNumber } = info;
      const vendorId = parseInt(info.vendorId as string, 16);
      const productId = parseInt(info.productId as string, 16);
      if (
        !VENDOR_IDS.includes(vendorId) &&
        !MANUFACTURERS.includes(manufacturer as string)
      ) {
        continue;
      }
      results.push({
        kind: "node-serial",
        path,
        vendorId,
        productId,
        serialNumber,
      });
    }
    return results;
  }

  /** Close the port. Safe to call before, during, or after connection. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.connectionAbort?.abort(new Error("Connection closed"));
    const port = this.connection;
    const pendingConnect = this.connectPromise;
    if (!port) return Promise.resolve();

    this.closePromise = (async () => {
      if (pendingConnect) await pendingConnect.catch(() => {});
      let writeError: Error | undefined;
      if (this.connected && port.isOpen) {
        try {
          await this.writeQueue;
          await this.writeRaw(Buffer.from(WS_CLOSE_FRAME));
        } catch (error) {
          writeError = asError(error, "Failed to send serial close frame");
        }
      }
      if (port.isOpen) {
        await new Promise<void>((resolve, reject) => {
          port.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      this.connected = false;
      if (this.connection === port) this.connection = undefined;
      if (writeError) throw writeError;
    })().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  /** Open the serial port and complete the protocol handshake. */
  connect(options: TransportConnectOptions = {}): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const controller = new AbortController();
    this.connectionAbort = controller;
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const promise = this.open({
      ...options,
      signal: controller.signal,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      if (this.connectionAbort === controller) this.connectionAbort = undefined;
      this.connectPromise = undefined;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async open({
    signal,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  }: TransportConnectOptions): Promise<void> {
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    const port = new SerialPort({
      path: this.path as string,
      baudRate: 256000,
    });
    this.connection = port;
    this.connected = false;

    port.on("error", (error: Error) => {
      if (!this.connected) return;
      this.connected = false;
      this.emit("disconnect", error);
    });
    port.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.connection === port) this.connection = undefined;
      if (wasConnected) this.emit("disconnect", undefined);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (port.isOpen) {
        port.close(() => {});
      } else {
        port.once("open", () => port.close(() => {}));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          port.off("open", onOpen);
          port.off("error", onError);
          port.off("close", onClose);
          signal?.removeEventListener("abort", onAbortSignal);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => fail(error);
        const onClose = () =>
          fail(new NotConnectedError("Serial port closed before opening"));
        const onAbortSignal = () =>
          fail(new OperationAbortedError(undefined, { cause: signal?.reason }));
        timer = setTimeout(
          () => fail(new ConnectionTimeoutError("Serial port open timed out")),
          timeoutMs,
        );
        port.once("open", onOpen);
        port.once("error", onError);
        port.once("close", onClose);
        signal?.addEventListener("abort", onAbortSignal, { once: true });
      });

      let handshake = Buffer.alloc(0);
      const response = new Promise<Buffer>((resolve, reject) => {
        let handshakeTimer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(handshakeTimer);
          port.off("data", onData);
          port.off("error", onError);
          port.off("close", onClose);
          signal?.removeEventListener("abort", onAbortSignal);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onError = (error: Error) => fail(error);
        const onClose = () =>
          fail(new NotConnectedError("Serial port closed during handshake"));
        const onAbortSignal = () =>
          fail(new OperationAbortedError(undefined, { cause: signal?.reason }));
        const onData = (chunk: Buffer) => {
          handshake = Buffer.concat([handshake, chunk]);
          if (
            !handshake
              .toString(
                "utf8",
                0,
                Math.min(handshake.length, WS_UPGRADE_RESPONSE.length),
              )
              .startsWith(
                WS_UPGRADE_RESPONSE.slice(
                  0,
                  Math.min(handshake.length, WS_UPGRADE_RESPONSE.length),
                ),
              )
          ) {
            fail(new ProtocolError("Invalid handshake response"));
            return;
          }
          const headerEnd = handshake.indexOf("\n\n");
          if (headerEnd === -1) {
            if (handshake.length > MAX_HANDSHAKE_BYTES) {
              fail(new ProtocolError("Handshake response is too large"));
            }
            return;
          }
          cleanup();
          resolve(handshake.subarray(headerEnd + 2));
        };
        handshakeTimer = setTimeout(
          () => fail(new ConnectionTimeoutError("Serial handshake timed out")),
          timeoutMs,
        );
        port.on("data", onData);
        port.once("error", onError);
        port.once("close", onClose);
        signal?.addEventListener("abort", onAbortSignal, { once: true });
      });
      // Observe handshake failures immediately, even if the request write fails first.
      response.catch(() => {});
      await this.writeRaw(Buffer.from(WS_UPGRADE_HEADER));
      const remainder = await response;

      const parser = new MagicByteLengthParser({ magicByte: 0x82 });
      port.pipe(parser);
      parser.on("data", (data: Buffer) => this.emit("message", data));
      if (remainder.length) parser.write(remainder);
      this.connected = true;
      this.emit("connect", { address: this.path });
    } catch (error) {
      if (port.isOpen) {
        await new Promise<void>((resolve) => port.close(() => resolve()));
      }
      if (this.connection === port) this.connection = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  isReady(): boolean {
    return this.connected && this.connection?.isOpen === true;
  }

  /** Serialize complete framed messages so concurrent writers cannot interleave. */
  send(buff: Uint8Array, raw = false): Promise<void> {
    const operation = this.writeQueue.then(() => this.sendOrdered(buff, raw));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  private async sendOrdered(buff: Uint8Array, raw: boolean): Promise<void> {
    if (!raw && !this.isReady()) throw new NotConnectedError();
    if (!this.connection) throw new NotConnectedError();
    if (!raw) {
      let prep: Buffer;
      if (buff.length > 0xff) {
        prep = Buffer.alloc(14);
        prep[0] = 0x82;
        prep[1] = 0xff;
        prep.writeUInt32BE(buff.length, 6);
      } else {
        prep = Buffer.alloc(6);
        prep[0] = 0x82;
        prep[1] = 0x80 + buff.length;
      }
      await this.writeRaw(prep);
    }
    await this.writeRaw(buff);
  }

  private async writeRaw(buff: Uint8Array): Promise<void> {
    const port = this.connection;
    if (!port || !port.isOpen) throw new NotConnectedError();
    const bytes = Buffer.from(buff.buffer, buff.byteOffset, buff.byteLength);
    const state = { accepted: false };
    const accepted = await new Promise<boolean>((resolve, reject) => {
      state.accepted = port.write(bytes, (error) => {
        queueMicrotask(() => {
          if (error) reject(error);
          else resolve(state.accepted);
        });
      });
    });
    if (!accepted) {
      await new Promise<void>((resolve, reject) => {
        port.once("drain", resolve);
        port.once("error", reject);
      });
    }
  }
}
