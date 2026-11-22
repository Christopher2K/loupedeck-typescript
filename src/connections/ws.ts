import { networkInterfaces } from "node:os";
import { Emitter as EventEmitter } from "strict-event-emitter";
import type { RawData } from "ws";
import WebSocket from "ws";

import { CONNECTION_TIMEOUT } from "../constants.js";
import {
  asError,
  ConnectionTimeoutError,
  NotConnectedError,
  OperationAbortedError,
  ProtocolError,
} from "../errors.js";
import type {
  TransportConnectOptions,
  WSConnectionInfo,
} from "../transport.js";

/** Events emitted by a {@link LoupedeckWSConnection}. */
export type WSConnectionEvents = {
  connect: [info: { address: string }];
  message: [data: Uint8Array];
  disconnect: [error: Error | undefined];
};

export interface WSConnectionOptions {
  host?: string;
}

export type { WSConnectionInfo } from "../transport.js";

/** WebSocket transport for firmware 0.1.x devices. */
export default class LoupedeckWSConnection extends EventEmitter<WSConnectionEvents> {
  host: string | undefined;
  address: string | undefined;
  lastTick: number;
  connectionTimeout: number;
  connection: WebSocket | undefined;

  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private connectionAbort: AbortController | undefined;
  private connected = false;

  constructor({ host }: WSConnectionOptions = {}) {
    super();
    this.host = host;
    this.lastTick = Date.now();
    this.connectionTimeout = CONNECTION_TIMEOUT;
  }

  static discover(): WSConnectionInfo[] {
    const results: WSConnectionInfo[] = [];
    for (const iface of Object.values(networkInterfaces()).flat()) {
      if (iface?.address.startsWith("100.127")) {
        results.push({
          kind: "websocket",
          vendorId: 0x2ec2,
          productId: 0x04,
          host: iface.address.replace(/\.2$/, ".1"),
        });
      }
    }
    return results;
  }

  checkConnected(): void {
    clearTimeout(this.keepAliveTimer);
    if (!this.isReady()) return;
    if (Date.now() - this.lastTick > this.connectionTimeout) {
      this.connection!.terminate();
      return;
    }
    this.keepAliveTimer = setTimeout(
      () => this.checkConnected(),
      this.connectionTimeout * 2,
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.connectionAbort?.abort(new Error("Connection closed"));
    clearTimeout(this.keepAliveTimer);
    const socket = this.connection;
    if (!socket) return Promise.resolve();
    if (socket.readyState === socket.CLOSED) {
      this.connection = undefined;
      this.connected = false;
      return Promise.resolve();
    }

    this.closePromise = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      if (socket.readyState === socket.CONNECTING) socket.terminate();
      else socket.close();
    }).finally(() => {
      if (this.connection === socket) this.connection = undefined;
      this.connected = false;
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

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

  private open({
    signal,
    timeoutMs = 3000,
  }: TransportConnectOptions): Promise<void> {
    this.address = `ws://${this.host}`;
    const socket = new WebSocket(this.address);
    this.connection = socket;
    this.connected = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new ConnectionTimeoutError("WebSocket connection timed out"));
        socket.terminate();
      }, timeoutMs);
      const cleanupOpening = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onOpeningError);
        socket.off("close", onOpeningClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupOpening();
        if (this.connection === socket) this.connection = undefined;
        reject(error);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanupOpening();
        this.connected = true;
        this.lastTick = Date.now();
        socket.on("error", onConnectedError);
        socket.on("message", onMessage);
        socket.on("close", onClose);
        this.emit("connect", { address: this.address! });
        this.checkConnected();
        resolve();
      };
      const onOpeningError = (error: Error) => fail(error);
      const onOpeningClose = (code: number) =>
        fail(
          new NotConnectedError(`WebSocket closed before opening (${code})`),
        );
      const onAbort = () => {
        fail(new OperationAbortedError(undefined, { cause: signal?.reason }));
        socket.terminate();
      };
      const onConnectedError = (error: Error) => {
        if (!this.connected) return;
        this.connected = false;
        clearTimeout(this.keepAliveTimer);
        this.emit("disconnect", error);
      };
      const onMessage = (data: RawData) => {
        this.lastTick = Date.now();
        try {
          this.emit("message", normalizeRawData(data));
        } catch (error) {
          onConnectedError(asError(error, "Invalid WebSocket message"));
          socket.terminate();
        }
      };
      const onClose = (code: number, reason: Buffer) => {
        clearTimeout(this.keepAliveTimer);
        const wasConnected = this.connected;
        this.connected = false;
        if (this.connection === socket) this.connection = undefined;
        socket.off("error", onConnectedError);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        if (!wasConnected) return;
        if (code === 1000) {
          this.emit("disconnect", undefined);
        } else {
          const detail = reason.toString();
          this.emit(
            "disconnect",
            new NotConnectedError(
              `WebSocket disconnected abnormally (${code})${detail ? `: ${detail}` : ""}`,
            ),
          );
        }
      };

      socket.once("open", onOpen);
      socket.once("error", onOpeningError);
      socket.once("close", onOpeningClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /** Record a keepalive tick and optionally decode a message. */
  onReceive(data?: RawData): void {
    this.lastTick = Date.now();
    if (data !== undefined) this.emit("message", normalizeRawData(data));
  }

  isReady(): boolean {
    return (
      this.connected &&
      this.connection !== undefined &&
      this.connection.readyState === this.connection.OPEN
    );
  }

  async send(buff: Uint8Array): Promise<void> {
    const socket = this.connection;
    if (!socket || !this.isReady()) throw new NotConnectedError();
    await new Promise<void>((resolve, reject) => {
      socket.send(buff, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new ProtocolError("Unsupported WebSocket message data");
}
