import { SerialPort } from "serialport";
import { Emitter as EventEmitter } from "strict-event-emitter";

import { MagicByteLengthParser } from "../parser.js";

const WS_UPGRADE_HEADER = `GET /index.html
HTTP/1.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: 123abc

`;
const WS_UPGRADE_RESPONSE = "HTTP/1.1";
const WS_CLOSE_FRAME = [0x88, 0x80, 0x00, 0x00, 0x00, 0x00];

const VENDOR_IDS = [
  0x2ec2, // Loupedeck
  0x1532, // Razer
];
const MANUFACTURERS = ["Loupedeck", "Razer"];

export type SerialConnectionEvents = {
  connect: [info: { address: string | undefined }];
  message: [data: Buffer];
  disconnect: [error: Error | undefined];
};

export interface SerialConnectionOptions {
  path?: string;
}

export interface SerialConnectionInfo {
  connectionType: typeof LoupedeckSerialConnection;
  path: string;
  vendorId: number;
  productId: number;
  serialNumber: string | undefined;
}

export default class LoupedeckSerialConnection extends EventEmitter<SerialConnectionEvents> {
  path: string | undefined;
  connection: SerialPort | undefined;

  constructor({ path }: SerialConnectionOptions = {}) {
    super();
    this.path = path;
  }

  // Automatically find Loupedeck Serial device by scanning ports
  static async discover(): Promise<SerialConnectionInfo[]> {
    const results: SerialConnectionInfo[] = [];
    for (const info of await SerialPort.list()) {
      const { manufacturer, path, serialNumber } = info;
      const vendorId = parseInt(info.vendorId as string, 16);
      const productId = parseInt(info.productId as string, 16);
      if (
        !VENDOR_IDS.includes(vendorId) &&
        !MANUFACTURERS.includes(manufacturer as string)
      )
        continue;
      results.push({
        connectionType: this,
        path,
        vendorId,
        productId,
        serialNumber,
      });
    }
    return results;
  }

  close(): Promise<Error | null> | undefined {
    if (!this.connection) return;
    this.send(Buffer.from(WS_CLOSE_FRAME), true);
    return new Promise((res) => this.connection!.close(res));
  }

  async connect(): Promise<void> {
    this.connection = new SerialPort({
      path: this.path as string,
      baudRate: 256000,
    });
    this.connection.on("error", this.onError.bind(this));
    this.connection.on("close", this.onDisconnect.bind(this));
    await new Promise<void>((res) => this.connection!.once("open", res));
    // Wait for the "websocket" handshake over serial (...)
    await new Promise<void>((res, rej) => {
      this.connection!.once("data", (buff: Buffer) => {
        if (buff.toString().startsWith(WS_UPGRADE_RESPONSE)) res();
        else rej("Invalid handshake response: ");
      });
      this.send(Buffer.from(WS_UPGRADE_HEADER), true);
    });

    // Set up data pipeline
    const parser = new MagicByteLengthParser({ magicByte: 0x82 });
    this.connection.pipe(parser);
    parser.on("data", this.emit.bind(this, "message"));

    this.emit("connect", { address: this.path });
  }

  isReady(): boolean {
    return this.connection !== undefined && this.connection.isOpen;
  }

  onDisconnect(err?: Error): void {
    this.emit("disconnect", err);
  }

  onError(err: Error): void {
    console.error(`Loupedeck Serial Error: ${err.message}`);
    this.onDisconnect(err);
  }

  send(buff: Buffer, raw = false): void {
    if (!raw) {
      let prep: Buffer;
      // Large messages
      if (buff.length > 0xff) {
        prep = Buffer.alloc(14);
        prep[0] = 0x82;
        prep[1] = 0xff;
        prep.writeUInt32BE(buff.length, 6);
        // Small messages
      } else {
        // Prepend each message with a send indicating the length to come
        prep = Buffer.alloc(6);
        prep[0] = 0x82;
        prep[1] = 0x80 + buff.length;
      }
      this.connection!.write(prep);
    }
    this.connection!.write(buff);
  }
}
