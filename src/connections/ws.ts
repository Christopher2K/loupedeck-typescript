import { networkInterfaces } from "node:os";
import { Emitter as EventEmitter } from "strict-event-emitter";
import type { RawData } from "ws";
import WebSocket from "ws";

import { CONNECTION_TIMEOUT } from "../constants.js";

const DISCONNECT_CODES = {
  NORMAL: 1000,
  TIMEOUT: 1006,
} as const;

export type WSConnectionEvents = {
  connect: [info: { address: string }];
  message: [data: RawData | undefined];
  disconnect: [error: Error | null];
};

export interface WSConnectionOptions {
  host?: string;
}

export interface WSConnectionInfo {
  connectionType: typeof LoupedeckWSConnection;
  productId: 0x04;
  host: string;
}

export default class LoupedeckWSConnection extends EventEmitter<WSConnectionEvents> {
  host: string | undefined;
  address: string | undefined;
  lastTick: number;
  connectionTimeout: number;
  connection: WebSocket | undefined;
  _keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  _connectionResolver: (() => void) | undefined;

  constructor({ host }: WSConnectionOptions = {}) {
    super();
    this.host = host;
    // Track last interaction time
    this.lastTick = Date.now();
    // How long until declaring a timed out connetion
    this.connectionTimeout = CONNECTION_TIMEOUT;
  }

  // Automatically find Loupedeck IP by scanning network interfaces
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

  checkConnected(): void {
    this._keepAliveTimer = setTimeout(
      this.checkConnected.bind(this),
      this.connectionTimeout * 2,
    );
    if (Date.now() - this.lastTick > this.connectionTimeout)
      this.connection!.terminate();
  }

  close(): Promise<number> | undefined {
    if (!this.connection) return;
    const closed = new Promise<number>((res) =>
      this.connection!.once("close", res),
    );
    this.connection.close();
    return closed;
  }

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

  isReady(): boolean {
    return (
      this.connection !== undefined &&
      this.connection.readyState === this.connection.OPEN
    );
  }

  onConnect(): void {
    this.emit("connect", { address: this.address! });
    this._keepAliveTimer = setTimeout(
      this.checkConnected.bind(this),
      this.connectionTimeout * 2,
    );
    this._connectionResolver!();
  }

  onDisconnect(errCode: number): void {
    let error: Error | null = null;
    switch (errCode) {
      case DISCONNECT_CODES.TIMEOUT:
        error = new Error("Connection timeout - was the device disconnected?");
    }
    clearTimeout(this._keepAliveTimer);
    this.emit("disconnect", error);
  }

  onReceive(buff?: RawData): void {
    this.lastTick = Date.now();
    this.emit("message", buff);
  }

  send(buff: Buffer): void {
    this.connection!.send(buff);
  }
}
