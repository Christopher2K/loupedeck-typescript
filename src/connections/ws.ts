import { networkInterfaces } from "node:os";
import { Emitter as EventEmitter } from "strict-event-emitter";
import type { RawData } from "ws";
import WebSocket from "ws";

import { CONNECTION_TIMEOUT } from "../constants.js";

const DISCONNECT_CODES = {
  NORMAL: 1000,
  TIMEOUT: 1006,
} as const;

/** Events emitted by a {@link LoupedeckWSConnection}. */
export type WSConnectionEvents = {
  /** Emitted when the WebSocket opens. */
  connect: [info: { address: string }];
  /** Emitted for each raw WebSocket message received. */
  message: [data: RawData | undefined];
  /** Emitted when the WebSocket closes, with an error for abnormal timeouts. */
  disconnect: [error: Error | null];
};

/** Options for creating a WebSocket connection. */
export interface WSConnectionOptions {
  /** Device host name or IP address, without a URL scheme. */
  host?: string;
}

/** Describes a candidate device address found through network discovery. */
export interface WSConnectionInfo {
  /** Connection class used to open this address. */
  connectionType: typeof LoupedeckWSConnection;
  /** Product identifier assigned to WebSocket discovery results. */
  productId: 0x04;
  /** Candidate device host address. */
  host: string;
}

/**
 * WebSocket transport for network-connected Loupedeck devices.
 *
 * Received messages act as keepalive ticks. Once connected, a periodic check
 * terminates the socket when no message has arrived within
 * {@link connectionTimeout}; close code 1006 is reported as a timeout error.
 */
export default class LoupedeckWSConnection extends EventEmitter<WSConnectionEvents> {
  /** Device host supplied at construction, without a URL scheme. */
  host: string | undefined;
  /** Full `ws://` URL, initialized by {@link connect}. */
  address: string | undefined;
  /** Timestamp in milliseconds of the most recently received message. */
  lastTick: number;
  /**
   * Maximum time in milliseconds between received messages before the socket
   * is terminated.
   *
   * @defaultValue `CONNECTION_TIMEOUT` (3000 milliseconds).
   */
  connectionTimeout: number;
  /** Underlying WebSocket, initialized by {@link connect}. */
  connection: WebSocket | undefined;
  /** Timer for the next keepalive check. */
  _keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolver for the promise returned by the current {@link connect} call. */
  _connectionResolver: (() => void) | undefined;

  /**
   * Creates an unopened WebSocket connection and initializes keepalive state.
   *
   * @param options - Connection options, including the device host. Defaults
   * to an empty object.
   */
  constructor({ host }: WSConnectionOptions = {}) {
    super();
    this.host = host;
    // Track last interaction time
    this.lastTick = Date.now();
    // How long until declaring a timed out connetion
    this.connectionTimeout = CONNECTION_TIMEOUT;
  }

  /**
   * Derives candidate device hosts from local network interface addresses.
   *
   * Interfaces whose addresses start with `100.127` are selected, and an
   * address ending in `.2` is mapped to the corresponding `.1` host. Discovery
   * is synchronous and does not probe or connect to the resulting hosts.
   *
   * @returns Candidate WebSocket connection descriptions.
   */
  static discover(): WSConnectionInfo[] {
    const results: WSConnectionInfo[] = [];
    const interfaces = Object.values(networkInterfaces()).flat();
    for (const iface of interfaces) {
      if (iface!.address.startsWith("100.127")) {
        results.push({
          connectionType: this,
          productId: 0x04,
          host: iface!.address.replace(/.2$/, ".1"),
        });
      }
    }
    return results;
  }

  /**
   * Schedules the next keepalive check and terminates the socket if the last
   * received message is older than {@link connectionTimeout}.
   *
   * Checks repeat every twice the connection timeout while the socket remains
   * connected.
   */
  checkConnected(): void {
    this._keepAliveTimer = setTimeout(
      this.checkConnected.bind(this),
      this.connectionTimeout * 2,
    );
    if (Date.now() - this.lastTick > this.connectionTimeout)
      this.connection!.terminate();
  }

  /**
   * Initiates a WebSocket close handshake.
   *
   * @returns A promise resolving to the WebSocket close code, or `undefined`
   * when no connection has been created.
   */
  close(): Promise<number> | undefined {
    if (!this.connection) return;
    const closed = new Promise<number>((res) =>
      this.connection!.once("close", res),
    );
    this.connection.close();
    return closed;
  }

  /**
   * Opens a WebSocket to `ws://<host>` and registers connection, message, and
   * close handlers.
   *
   * @returns A promise resolved by {@link onConnect} after the socket opens.
   * The connection attempt itself has no separate timeout or rejection path.
   * @throws If the WebSocket URL is invalid or the socket cannot be created.
   */
  connect(): Promise<void> {
    this.address = `ws://${this.host}`;
    this.connection = new WebSocket(this.address);
    this.connection.on("open", this.onConnect.bind(this));
    this.connection.on("message", this.onReceive.bind(this));
    this.connection.on("close", this.onDisconnect.bind(this));
    return new Promise((res) => {
      this._connectionResolver = res;
    });
  }

  /**
   * Reports whether the WebSocket is fully open.
   *
   * @returns `true` only when the socket exists and its ready state is `OPEN`.
   */
  isReady(): boolean {
    return (
      this.connection !== undefined &&
      this.connection.readyState === this.connection.OPEN
    );
  }

  /**
   * Handles socket opening by emitting `connect`, starting keepalive checks,
   * and resolving the pending {@link connect} promise.
   */
  onConnect(): void {
    this.emit("connect", { address: this.address! });
    this._keepAliveTimer = setTimeout(
      this.checkConnected.bind(this),
      this.connectionTimeout * 2,
    );
    this._connectionResolver!();
  }

  /**
   * Handles socket closure, stops keepalive checks, and emits `disconnect`.
   *
   * @param errCode - WebSocket close code. Code 1006 produces a timeout error;
   * all other codes produce a `null` disconnect error.
   */
  onDisconnect(errCode: number): void {
    let error: Error | null = null;
    switch (errCode) {
      case DISCONNECT_CODES.TIMEOUT:
        error = new Error("Connection timeout - was the device disconnected?");
    }
    clearTimeout(this._keepAliveTimer);
    this.emit("disconnect", error);
  }

  /**
   * Handles an incoming message by refreshing the keepalive timestamp and
   * emitting the unmodified data as `message`.
   *
   * @param buff - Raw data supplied by the WebSocket implementation.
   */
  onReceive(buff?: RawData): void {
    this.lastTick = Date.now();
    this.emit("message", buff);
  }

  /**
   * Sends a buffer directly as a WebSocket message, without adding the serial
   * transport's length-prefixed framing.
   *
   * @param buff - Payload bytes to send.
   * @throws If called before {@link connect} initializes the socket or if the
   * socket cannot accept the message.
   */
  send(buff: Buffer): void {
    this.connection!.send(buff);
  }
}
