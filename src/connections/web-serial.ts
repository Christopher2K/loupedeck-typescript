import { Emitter as EventEmitter } from "strict-event-emitter";

import {
  concatBytes,
  decodeText,
  encodeText,
  writeUint32BE,
} from "../bytes.js";
import {
  asError,
  ConnectionTimeoutError,
  DeviceClosedError,
  DisconnectedError,
  NotConnectedError,
  OperationAbortedError,
  ProtocolError,
} from "../errors.js";
import { MagicByteLengthDecoder } from "../frame-decoder.js";
import type {
  TransportConnectOptions,
  WebSerialConnectionInfo,
  WebSerialPortLike,
} from "../transport.js";

const WS_UPGRADE_HEADER = `GET /index.html
HTTP/1.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: 123abc

`;
const WS_UPGRADE_RESPONSE = "HTTP/1.1";
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const VENDOR_IDS = [0x2ec2, 0x1532];

export type WebSerialConnectionEvents = {
  connect: [info: { address: "web" }];
  message: [data: Uint8Array];
  disconnect: [reason: Error | undefined];
};

export interface WebSerialConnectionOptions {
  port: WebSerialPortLike;
}

export type { WebSerialConnectionInfo } from "../transport.js";

/** Browser Web Serial transport with deterministic stream ownership. */
export default class LoupedeckWebSerialConnection extends EventEmitter<WebSerialConnectionEvents> {
  readonly port: WebSerialPortLike;

  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private aborter: AbortController | undefined;
  private readTask: Promise<void> | undefined;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private connected = false;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly onNativeDisconnect = () => {
    if (!this.connected) return;
    this.connected = false;
    this.emit(
      "disconnect",
      new DisconnectedError("The browser reported a serial disconnection"),
    );
  };

  constructor({ port }: WebSerialConnectionOptions) {
    super();
    if (!port) throw new TypeError("A Web Serial port is required");
    this.port = port;
    port.addEventListener("disconnect", this.onNativeDisconnect);
  }

  /** List already-authorized supported ports without displaying a chooser. */
  static async discover(): Promise<WebSerialConnectionInfo[]> {
    if (!navigator.serial)
      throw new NotConnectedError("Web Serial is unavailable");
    const connections: WebSerialConnectionInfo[] = [];
    for (const port of await navigator.serial.getPorts()) {
      const info = await port.getInfo();
      if (
        info.usbVendorId === undefined ||
        info.usbProductId === undefined ||
        !VENDOR_IDS.includes(info.usbVendorId)
      ) {
        continue;
      }
      connections.push({
        kind: "web-serial",
        port,
        productId: info.usbProductId,
        vendorId: info.usbVendorId,
      });
    }
    return connections;
  }

  /** Display the browser chooser. Call this from a user-activation handler. */
  static async request(): Promise<WebSerialConnectionInfo> {
    if (!navigator.serial)
      throw new NotConnectedError("Web Serial is unavailable");
    const port = await navigator.serial.requestPort({
      filters: VENDOR_IDS.map((usbVendorId) => ({ usbVendorId })),
    });
    const info = await port.getInfo();
    if (info.usbVendorId === undefined || info.usbProductId === undefined) {
      throw new ProtocolError(
        "The selected port did not expose USB identifiers",
      );
    }
    return {
      kind: "web-serial",
      port,
      productId: info.usbProductId,
      vendorId: info.usbVendorId,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const wasConnected = this.connected;
    this.connected = false;
    this.aborter?.abort(new DeviceClosedError());
    this.port.removeEventListener("disconnect", this.onNativeDisconnect);

    this.closePromise = (async () => {
      await this.reader?.cancel().catch(() => {});
      await this.readTask;
      await this.writeQueue;
      if (this.writer) {
        try {
          await this.writer.close();
        } catch {
          this.writer.abort().catch(() => {});
        } finally {
          this.writer.releaseLock();
          this.writer = undefined;
        }
      }
      if (this.port.readable || this.port.writable) await this.port.close();
      if (wasConnected) this.emit("disconnect", undefined);
    })();
    return this.closePromise;
  }

  connect(options: TransportConnectOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new DeviceClosedError());
    if (this.isReady()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const controller = new AbortController();
    this.aborter = controller;
    const abort = () => {
      controller.abort(options.signal?.reason);
      void this.reader?.cancel().catch(() => {});
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const promise = this.open({
      ...options,
      signal: controller.signal,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      this.connectPromise = undefined;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async open({
    signal,
    timeoutMs = 3000,
  }: TransportConnectOptions): Promise<void> {
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    let handshakeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!this.port.readable || !this.port.writable) {
        await this.port.open({ baudRate: 256000 });
      }
      if (!this.port.readable || !this.port.writable) {
        throw new NotConnectedError("Web Serial streams are unavailable");
      }
      this.writer = this.port.writable.getWriter();
      handshakeReader = this.port.readable.getReader();
      this.reader = handshakeReader;

      const responsePromise = readHandshake(handshakeReader, signal, timeoutMs);
      await this.writeRaw(encodeText(WS_UPGRADE_HEADER));
      const remainder = await responsePromise;
      handshakeReader.releaseLock();
      this.reader = undefined;
      handshakeReader = undefined;

      this.connected = true;
      this.emit("connect", { address: "web" });
      this.readTask = this.readLoop(remainder, signal);
    } catch (error) {
      this.connected = false;
      if (handshakeReader) {
        await handshakeReader.cancel().catch(() => {});
        handshakeReader.releaseLock();
        this.reader = undefined;
      }
      if (this.writer) {
        await this.writer.abort(error).catch(() => {});
        this.writer.releaseLock();
        this.writer = undefined;
      }
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
      throw error;
    }
  }

  isReady(): boolean {
    return (
      this.connected &&
      !this.closed &&
      this.port.readable !== null &&
      this.port.writable !== null
    );
  }

  private async readLoop(
    initialData: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoder = new MagicByteLengthDecoder(0x82);
    let failure: Error | undefined;
    try {
      for (const frame of decoder.push(initialData))
        this.emit("message", frame);
      const reader = this.port.readable!.getReader();
      this.reader = reader;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          for (const frame of decoder.push(value)) this.emit("message", frame);
        }
      }
      if (!this.closed) decoder.finish();
    } catch (error) {
      if (!this.closed && !signal?.aborted) {
        failure = asError(error, "Web Serial read failed");
      }
    } finally {
      this.reader?.releaseLock();
      this.reader = undefined;
      this.connected = false;
      if (failure) {
        if (this.writer) {
          await this.writer.abort(failure).catch(() => {});
          this.writer.releaseLock();
          this.writer = undefined;
        }
        if (this.port.readable || this.port.writable) {
          await this.port.close().catch(() => {});
        }
        this.emit("disconnect", failure);
      } else if (!this.closed) {
        this.emit("disconnect", undefined);
      }
    }
  }

  send(buff: Uint8Array, raw = false): Promise<void> {
    const operation = this.writeQueue.then(() => this.sendOrdered(buff, raw));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  private async sendOrdered(buff: Uint8Array, raw: boolean): Promise<void> {
    if (!raw && !this.isReady()) throw new NotConnectedError();
    if (!raw) {
      let prep: Uint8Array;
      if (buff.length > 0xff) {
        prep = new Uint8Array(14);
        prep[0] = 0x82;
        prep[1] = 0xff;
        writeUint32BE(prep, buff.length, 6);
      } else {
        prep = new Uint8Array(6);
        prep[0] = 0x82;
        prep[1] = 0x80 + buff.length;
      }
      await this.writeRaw(prep);
    }
    await this.writeRaw(buff);
  }

  private async writeRaw(buff: Uint8Array): Promise<void> {
    if (!this.writer) throw new NotConnectedError();
    await this.writer.write(buff);
  }
}

async function readHandshake(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Uint8Array> {
  let data: Uint8Array = new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new ConnectionTimeoutError("Web Serial handshake timed out")),
      timeoutMs,
    );
  });
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new OperationAbortedError(
          "Web Serial stream ended during handshake",
          { cause: signal?.reason },
        );
      }
      if (value) data = concatBytes(data, value);
      const prefix = data.subarray(0, WS_UPGRADE_RESPONSE.length);
      if (
        data.length > MAX_HANDSHAKE_BYTES ||
        (prefix.length === WS_UPGRADE_RESPONSE.length &&
          decodeText(prefix) !== WS_UPGRADE_RESPONSE)
      ) {
        throw new ProtocolError("Invalid Web Serial handshake response");
      }
      for (let index = 0; index + 1 < data.length; index++) {
        if (data[index] === 10 && data[index + 1] === 10) {
          return data.subarray(index + 2);
        }
      }
    }
  })();
  try {
    return await Promise.race([reading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
