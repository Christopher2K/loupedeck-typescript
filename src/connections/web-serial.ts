/** biome-ignore-all lint/suspicious/noAssignInExpressions: Preserve the frame-scanning loop behavior. */

import { Emitter as EventEmitter } from "strict-event-emitter";

const WS_UPGRADE_HEADER = `GET /index.html
HTTP/1.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: 123abc

`;
const WS_UPGRADE_RESPONSE = "HTTP/1.1";

/**
 * Transform-stream adapter that extracts length-prefixed payloads from serial
 * byte chunks.
 *
 * The byte following each `magicByte` is the unsigned payload length. Partial
 * frames remain buffered between chunks; bytes before a delimiter are
 * discarded once that frame is emitted.
 */
class MagicByteLengthParser implements Transformer<Uint8Array, Buffer> {
  /** Bytes retained because no complete frame has yet been parsed. */
  buffer: Buffer;
  /** Byte value that marks the start of a frame. */
  delimiter: number;

  /**
   * Creates an empty frame parser.
   *
   * @param options - Parser options.
   * @param options.magicByte - Byte value marking the start of each frame.
   */
  constructor({ magicByte }: { magicByte: number }) {
    this.buffer = Buffer.alloc(0);
    this.delimiter = magicByte;
  }

  /**
   * Parses a chunk together with any previously buffered bytes and enqueues
   * every complete frame payload.
   *
   * @param chunk - Next bytes received from the serial stream.
   * @param controller - Transform controller used to enqueue payload buffers.
   */
  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Buffer>,
  ): void {
    let data = Buffer.concat([this.buffer, chunk]);
    let position: number;
    while ((position = data.indexOf(this.delimiter)) !== -1) {
      // We need to at least be able to read the length byte
      if (data.length < position + 2) break;
      const nextLength = data[position + 1];
      // Make sure we have enough bytes to meet this length
      const expectedEnd = position + nextLength + 2;
      if (data.length < expectedEnd) break;
      controller.enqueue(data.slice(position + 2, expectedEnd));
      data = data.slice(expectedEnd);
    }
    this.buffer = data;
  }

  /**
   * Enqueues any bytes left in the buffer when the input stream ends,
   * including an incomplete or unframed trailing sequence.
   *
   * @param controller - Transform controller used to enqueue the final buffer.
   */
  flush(controller: TransformStreamDefaultController<Buffer>): void {
    controller.enqueue(this.buffer);
  }
}

/**
 * Reads a Web Serial port and yields payloads from `0x82`-delimited frames.
 *
 * Errors encountered while reading are logged and end iteration rather than
 * being rethrown. The transformed stream's reader lock is always released.
 *
 * @param port - Open Web Serial port with a readable stream.
 * @param options - Read pipeline options.
 * @param options.signal - Abort signal forwarded to the stream pipeline.
 * @yields Payload buffers extracted from complete incoming frames.
 * @returns An async generator that finishes when the stream closes or aborts.
 */
async function* read(
  port: SerialPort,
  { signal }: { signal: AbortSignal },
): AsyncGenerator<Buffer, void, unknown> {
  const transformer = new TransformStream<Uint8Array, Buffer>(
    new MagicByteLengthParser({ magicByte: 0x82 }),
  );
  const transformed = port.readable!.pipeThrough(transformer, { signal });
  const reader = transformed.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } catch (error) {
    console.error("error", error);
  } finally {
    reader.releaseLock();
  }
}

/** Events emitted by a {@link LoupedeckWebSerialConnection}. */
export type WebSerialConnectionEvents = {
  /** Emitted after the serial handshake and read pipeline are initialized. */
  connect: [info: { address: "web" }];
  /** Emitted for each payload extracted from an incoming length-prefixed frame. */
  message: [data: Buffer];
  /** Emitted for a browser port disconnect or a forwarded serial error. */
  disconnect: [reason: Event | Error];
  /** Emitted when the background read loop finishes, including after close. */
  readEnd: [];
};

/** Options for creating a browser Web Serial connection. */
export interface WebSerialConnectionOptions {
  /** Authorized Web Serial port to use. */
  port: SerialPort;
}

/** Describes a Web Serial port selected or authorized in the browser. */
export interface WebSerialConnectionInfo {
  /** Connection class used to open this port. */
  connectionType: typeof LoupedeckWebSerialConnection;
  /** Browser Web Serial port object. */
  port: SerialPort;
  /** USB product ID, when exposed by the browser. */
  productId: number | undefined;
  /** USB vendor ID, when exposed by the browser. */
  vendorId: number | undefined;
}

/**
 * Browser Web Serial transport for Loupedeck and Razer devices.
 *
 * The connection opens an authorized port at 256,000 baud, performs the serial
 * WebSocket-upgrade handshake, and reads `0x82`-delimited frames on a
 * background async pipeline. Closing aborts that pipeline before closing the
 * port.
 */
export default class LoupedeckWebSerialConnection extends EventEmitter<WebSerialConnectionEvents> {
  /** Web Serial port supplied at construction. */
  port: SerialPort;
  /** Writer for the port's writable stream, initialized by {@link connect}. */
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  /** Controller used by {@link close} to abort the read pipeline. */
  aborter: AbortController | undefined;
  /** Parsed incoming stream consumed by the background {@link read} loop. */
  readStream: AsyncGenerator<Buffer, void, unknown> | undefined;

  /**
   * Creates an unopened connection for an authorized Web Serial port and
   * subscribes to the port's browser `disconnect` event.
   *
   * @param options - Options containing the Web Serial port to use.
   */
  constructor(
    { port }: WebSerialConnectionOptions = {} as WebSerialConnectionOptions,
  ) {
    super();
    this.port = port;
    port.addEventListener("disconnect", this.onDisconnect.bind(this));
  }

  /**
   * Gets previously authorized Web Serial ports, or asks the browser to let
   * the user authorize one when none are available.
   *
   * The browser chooser is filtered to USB vendor IDs `0x2ec2` (Loupedeck) and
   * `0x1532` (Razer). Requesting a port requires browser Web Serial support and
   * is subject to the browser's secure-context and user-activation rules.
   * Discovery does not open the returned ports.
   *
   * @returns Descriptions of authorized or newly selected ports.
   * @throws Rejects if Web Serial is unavailable, the user cancels or the
   * browser denies the request, or port information cannot be read.
   */
  static async discover(): Promise<WebSerialConnectionInfo[]> {
    // Return authorized ports if available
    const ports = await navigator.serial.getPorts();
    if (!ports.length) {
      // Request a new port
      ports.push(
        await navigator.serial.requestPort({
          filters: [{ usbVendorId: 0x2ec2 }, { usbVendorId: 0x1532 }],
        }),
      );
    }
    const connections: WebSerialConnectionInfo[] = [];
    for (const port of ports) {
      const info = await port.getInfo();
      connections.push({
        connectionType: this,
        port,
        productId: info.usbProductId,
        vendorId: info.usbVendorId,
      });
    }
    return connections;
  }

  /**
   * Aborts the read pipeline and closes the Web Serial port.
   *
   * The method waits for `readEnd`, initiates closing and releases the writer,
   * then allows the `pipeThrough()` reader lock a tick to clear before calling
   * the port's `close()` method. It expects an active connection.
   *
   * @returns Resolves after the port has closed.
   * @throws Rejects if closing the port fails; calling this without an active
   * connection also fails because the abort controller and writer are absent.
   */
  async close(): Promise<void> {
    this.aborter!.abort("Manual close initiated");
    await new Promise<void>((res) => this.on("readEnd", res));
    this.writer!.close();
    this.writer!.releaseLock();
    // Without the line below, the serialport will refuse to close with
    // "TypeError: Failed to execute 'close': Cannot cancel a locked stream"
    //
    // However, the port.readable stream should have been unlocked via reader.releaseLock() (see read() above)
    //
    // Apparently it unlocks after a one tick propagation (due to pipeThrough()), but there doesn't
    // seem to be a promise anywhere to await this happening...
    //
    // Annoyingly, we have to wait one tick here which is really hacky
    await new Promise((res) => setTimeout(res, 10));
    await this.port.close();
  }

  /**
   * Opens the port when necessary, performs the serial WebSocket-upgrade
   * handshake, and starts the background frame-reading loop.
   *
   * A raw upgrade request is sent after acquiring the port's reader and
   * writer. The response must start with `HTTP/1.1`. On success, the handshake
   * reader is released, an abortable parsing pipeline is installed, and
   * `connect` is emitted before background reading begins.
   *
   * @returns Resolves once the handshake and read-pipeline setup complete.
   * @throws Rejects if the port cannot open, stream setup fails, or the
   * handshake response is invalid.
   */
  async connect(): Promise<void> {
    if (!this.isReady()) {
      await this.port.open({ baudRate: 256000 });
    }

    const reader = this.port.readable!.getReader();
    this.writer = this.port.writable!.getWriter();

    // Wait for the "websocket" handshake over serial (...)
    const nextMessage = reader.read();
    this.send(Buffer.from(WS_UPGRADE_HEADER), true);
    const { value: response } = await nextMessage;
    const stringResponse = new TextDecoder().decode(response);
    if (!stringResponse.startsWith(WS_UPGRADE_RESPONSE))
      throw new Error(`Invalid handshake response: ${stringResponse}`);
    reader.releaseLock();

    // Set up data pipeline
    this.aborter = new AbortController();
    this.readStream = read(this.port, this.aborter);
    this.emit("connect", { address: "web" });
    this.read();
  }

  /**
   * Reports readiness using the browser port's readable stream.
   *
   * This reflects whether the port is open, not whether the protocol handshake
   * has completed.
   *
   * @returns The port's readable stream when open, otherwise `null`.
   */
  isReady(): ReadableStream<Uint8Array> | null {
    return this.port && this.port.readable;
  }

  /**
   * Forwards a browser disconnect event or serial error as `disconnect`.
   *
   * @param err - Browser event or error describing the disconnect.
   */
  onDisconnect(err: Event | Error): void {
    // TODO
    this.emit("disconnect", err);
  }

  /**
   * Logs a serial error and forwards it to {@link onDisconnect}.
   *
   * @param err - Serial error to report.
   */
  onError(err: Error): void {
    // TODO
    console.error(`Loupedeck Serial Error: ${err.message}`);
    this.onDisconnect(err);
  }

  /**
   * Consumes the parsed read stream, emitting each payload as `message` while
   * the port remains readable, and emits `readEnd` when iteration finishes.
   *
   * {@link connect} starts this loop without awaiting it.
   *
   * @returns Resolves after the read stream ends and `readEnd` is emitted.
   * @throws Rejects if called before {@link connect} initializes the read stream.
   */
  async read(): Promise<void> {
    for await (const message of this.readStream!) {
      if (!this.port.readable) break;
      this.emit("message", message);
    }
    this.emit("readEnd");
  }

  /**
   * Writes a payload to the Web Serial port.
   *
   * By default, the payload is preceded by a six-byte header for payloads up to
   * 255 bytes or a 14-byte header for larger payloads. Both headers start with
   * `0x82`. Small headers store `0x80 + payload length` in byte 1; large headers
   * use `0xff` there and store the payload length as a big-endian 32-bit integer
   * at offset 6. Raw sends write only `buff`.
   *
   * @param buff - Payload bytes to write.
   * @param raw - Whether to bypass protocol framing and write only `buff`.
   * Defaults to `false`.
   * @returns A promise for the payload write. The header write, when present,
   * is initiated first but not separately awaited.
   * @throws Throws if called before {@link connect} initializes the writer.
   * The returned promise rejects if the payload write fails.
   */
  send(buff: Buffer, raw = false): Promise<void> {
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
      this.writer!.write(prep);
    }
    return this.writer!.write(buff);
  }
}
