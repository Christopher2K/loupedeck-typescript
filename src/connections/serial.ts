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

/** Events emitted by a {@link LoupedeckSerialConnection}. */
export type SerialConnectionEvents = {
  /** Emitted after the serial port opens and the protocol handshake completes. */
  connect: [info: { address: string | undefined }];
  /** Emitted for each payload extracted from an incoming length-prefixed frame. */
  message: [data: Buffer];
  /** Emitted when the port closes or reports an error. */
  disconnect: [error: Error | undefined];
};

/** Options for creating a serial connection. */
export interface SerialConnectionOptions {
  /** Path of the serial port to open, as returned by discovery. */
  path?: string;
}

/** Describes a serial port discovered as a possible Loupedeck device. */
export interface SerialConnectionInfo {
  /** Connection class used to open this port. */
  connectionType: typeof LoupedeckSerialConnection;
  /** System-specific serial port path. */
  path: string;
  /** USB vendor ID parsed from the port's hexadecimal identifier. */
  vendorId: number;
  /** USB product ID parsed from the port's hexadecimal identifier. */
  productId: number;
  /** Device serial number, when supplied by the operating system. */
  serialNumber: string | undefined;
}

/**
 * Node.js serial transport for Loupedeck and Razer devices.
 *
 * The connection opens a {@link SerialPort}, performs the device's HTTP
 * WebSocket-upgrade handshake over serial, and then exposes payload data from
 * `0x82`-delimited, length-prefixed frames through the `message` event.
 */
export default class LoupedeckSerialConnection extends EventEmitter<SerialConnectionEvents> {
  /** Serial port path supplied at construction. */
  path: string | undefined;
  /** Underlying serial port, initialized by {@link connect}. */
  connection: SerialPort | undefined;

  /**
   * Creates an unopened serial connection.
   *
   * @param options - Connection options, including the port path to open.
   * Defaults to an empty object.
   */
  constructor({ path }: SerialConnectionOptions = {}) {
    super();
    this.path = path;
  }

  /**
   * Lists serial ports whose USB vendor ID or manufacturer identifies them as
   * Loupedeck or Razer devices.
   *
   * Discovery only enumerates ports; it does not open them or verify the
   * protocol handshake.
   *
   * @returns Descriptions of all matching serial ports.
   * @throws Rejects if the operating system's serial ports cannot be listed.
   */
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

  /**
   * Sends a raw WebSocket close frame and closes the underlying serial port.
   *
   * @returns A promise resolving to the port's close error or `null`, or
   * `undefined` when no connection has been created.
   */
  close(): Promise<Error | null> | undefined {
    if (!this.connection) return;
    this.send(Buffer.from(WS_CLOSE_FRAME), true);
    return new Promise((res) => this.connection!.close(res));
  }

  /**
   * Opens the configured port at 256,000 baud and performs the serial
   * WebSocket-upgrade handshake.
   *
   * After a valid `HTTP/1.1` response, incoming data is parsed into framed
   * payloads and the `connect` event is emitted.
   *
   * @returns Resolves after the handshake succeeds and the parser is installed.
   * @throws Rejects if port construction or setup throws, or if the handshake
   * response is invalid.
   */
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

  /**
   * Reports whether the underlying serial port is open.
   *
   * The port can be open while {@link connect} is still awaiting the protocol
   * handshake.
   *
   * @returns `true` when a serial port exists and its `isOpen` flag is set.
   */
  isReady(): boolean {
    return this.connection !== undefined && this.connection.isOpen;
  }

  /**
   * Handles a serial port close by emitting the connection's `disconnect` event.
   *
   * @param err - Error associated with the disconnect, if any.
   */
  onDisconnect(err?: Error): void {
    this.emit("disconnect", err);
  }

  /**
   * Logs a serial port error and emits `disconnect` with the same error.
   *
   * @param err - Error reported by the serial port.
   */
  onError(err: Error): void {
    console.error(`Loupedeck Serial Error: ${err.message}`);
    this.onDisconnect(err);
  }

  /**
   * Writes a payload to the serial port.
   *
   * By default, the payload is preceded by a protocol header: six bytes for
   * payloads up to 255 bytes, or 14 bytes for larger payloads. Both headers
   * start with `0x82`. Small headers store `0x80 + payload length` in byte 1;
   * large headers use `0xff` there and store the payload length as a big-endian
   * 32-bit integer at offset 6. Raw sends write only `buff`.
   *
   * @param buff - Payload bytes to write.
   * @param raw - Whether to bypass protocol framing and write only `buff`.
   * Defaults to `false`.
   * @throws If called before {@link connect} initializes the serial port.
   */
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
