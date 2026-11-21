import rgba from "color-rgba";
import { Emitter as EventEmitter } from "strict-event-emitter";

import type LoupedeckSerialConnection from "./connections/serial.js";
import type { SerialConnectionInfo } from "./connections/serial.js";
import type LoupedeckWebSerialConnection from "./connections/web-serial.js";
import type { WebSerialConnectionInfo } from "./connections/web-serial.js";
import type LoupedeckWSConnection from "./connections/ws.js";
import type { WSConnectionInfo } from "./connections/ws.js";
import type { ButtonId, ControlId, KnobId } from "./constants.js";
import {
  BUTTONS,
  COMMANDS,
  DEFAULT_RECONNECT_INTERVAL,
  HAPTIC,
  MAX_BRIGHTNESS,
} from "./constants.js";
import type {
  ConnectInfo,
  DeviceInfo,
  DisconnectReason,
  DisplayInfo,
  DisplayMap,
  DrawCallback,
  DrawOptions,
  ListOptions,
  LoupedeckDeviceEvents,
  LoupedeckDeviceOptions,
  PacketHandler,
  PacketResponse,
  ScreenId,
  Touch,
  TouchTarget,
  TransactionResolver,
} from "./types.js";
import { rgba2rgb565 } from "./util.js";

export type DiscoveredConnection =
  | SerialConnectionInfo
  | WSConnectionInfo
  | WebSerialConnectionInfo;
export type AnyConnection =
  | LoupedeckSerialConnection
  | LoupedeckWSConnection
  | LoupedeckWebSerialConnection;

type DeviceConnectionConstructor = new (
  options: LoupedeckDeviceOptions,
) => AnyConnection;

interface SerialConnectionConstructor {
  new (options: { path?: string; port?: SerialPort }): AnyConnection;
  /** Discovers available serial or Web Serial connections. */
  discover(): Promise<Array<SerialConnectionInfo | WebSerialConnectionInfo>>;
}

interface DeviceConnection {
  /** Opens the underlying transport. */
  connect(): Promise<void>;
  /** Listens for a successful connection. */
  on(event: "connect", listener: (info: ConnectInfo) => void): unknown;
  /** Listens for incoming device payloads. */
  on(event: "message", listener: (packet: Buffer) => void): unknown;
  /** Listens for transport disconnection. */
  on(event: "disconnect", listener: (error: DisconnectReason) => void): unknown;
}

let SerialConnection: SerialConnectionConstructor;
let WSConnection: typeof LoupedeckWSConnection | undefined;
// Only import when in a browser environment
if (
  (typeof navigator !== "undefined" && navigator.serial) ||
  import.meta.env?.PROD
) {
  SerialConnection = (await import("./connections/web-serial.js"))
    .default as unknown as SerialConnectionConstructor;
} else {
  SerialConnection = (await import("./connections/serial.js")).default;
  WSConnection = (await import("./connections/ws.js")).default;
}

let canvasModule: typeof import("canvas") | undefined;
try {
  canvasModule = await import("canvas");
} catch {
  // No canvas is ok, do check in `drawCanvas`
}

/**
 * Shared interface for Loupedeck-compatible devices.
 *
 * Emits connection, button, rotation, and touch events. After an abnormal
 * disconnect, reconnection is attempted unless disabled in the constructor.
 * Use a device-specific subclass rather than instantiating this base class.
 */
export class LoupedeckDevice extends EventEmitter<LoupedeckDeviceEvents> {
  declare displays: DisplayMap;
  declare columns: number;
  declare rows: number;
  declare visibleX: [number, number];

  keySize = 90;
  transactionID: number;
  touches: Record<number, Touch>;
  handlers: Record<number, PacketHandler>;
  pendingTransactions: Record<number, TransactionResolver | undefined>;
  reconnectInterval: number | false;
  host: string | undefined;
  path: string | undefined;
  port: SerialPort | undefined;
  connection: AnyConnection | null | undefined;
  _reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Discovers available serial, Web Serial, and WebSocket devices in parallel.
   * WebSocket discovery is available only in environments that support it.
   *
   * @param options - Discovery filters.
   * @param options.ignoreSerial - Skip serial and Web Serial discovery.
   * @defaultValue `false`
   * @param options.ignoreWebsocket - Skip WebSocket discovery.
   * @defaultValue `false`
   * @returns Connection descriptors for all discovered devices.
   */
  static async list({
    ignoreSerial = false,
    ignoreWebsocket = false,
  }: ListOptions = {}): Promise<DiscoveredConnection[]> {
    const ps: Array<Promise<DiscoveredConnection[]> | DiscoveredConnection[]> =
      [];

    if (!ignoreSerial) ps.push(SerialConnection.discover());
    if (!ignoreWebsocket && WSConnection) ps.push(WSConnection.discover());

    // Run them in parallel
    const rawDevices = await Promise.all(ps);

    return rawDevices.flat();
  }

  /**
   * Creates a device interface and optionally starts connecting immediately.
   * A serial `path` or `port` selects a serial connection; otherwise `host`
   * selects WebSocket. With none of these options, the first discovered device
   * is used. Initial automatic connection failures are suppressed.
   *
   * @param options - Connection and reconnection options.
   * @param options.host - WebSocket host or IP address for firmware 0.1.x.
   * @param options.path - Serial device path for firmware 0.2.x.
   * @param options.port - Browser Web Serial port for firmware 0.2.x.
   * @param options.autoConnect - Start a connection attempt during construction.
   * @defaultValue `true`
   * @param options.reconnectInterval - Milliseconds to wait before reconnecting
   * after an abnormal disconnect, or `false` to disable automatic reconnection.
   * @defaultValue `DEFAULT_RECONNECT_INTERVAL` (3000 ms)
   */
  constructor({
    host,
    path,
    port,
    autoConnect = true,
    reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
  }: LoupedeckDeviceOptions = {}) {
    super();
    this.transactionID = 0;
    this.touches = {};
    this.handlers = {
      [COMMANDS.BUTTON_PRESS]: this.onButton.bind(this),
      [COMMANDS.KNOB_ROTATE]: this.onRotate.bind(this),
      [COMMANDS.SERIAL]: (buff) => buff.toString().trim(),
      [(COMMANDS as unknown as { TICK: number }).TICK]: () => undefined,
      [COMMANDS.TOUCH]: this.onTouch.bind(this, "touchmove"),
      [COMMANDS.TOUCH_END]: this.onTouch.bind(this, "touchend"),
      [COMMANDS.VERSION]: (buff) => `${buff[0]}.${buff[1]}.${buff[2]}`,
      [COMMANDS.TOUCH_CT]: this.onTouch.bind(this, "touchmove"),
      [COMMANDS.TOUCH_END_CT]: this.onTouch.bind(this, "touchend"),
    };
    // Track pending transactions
    this.pendingTransactions = {};
    // How long between reconnect attempts
    this.reconnectInterval = reconnectInterval;
    // Host for websocket connections
    this.host = host;
    // Path or port for serial connections
    this.path = path;
    this.port = port;
    // Automatically connect?
    if (autoConnect) this._connectBlind();
  }

  /**
   * Closes the current transport connection.
   *
   * @returns A promise that settles when the close operation completes, or
   * `undefined` if there is no current connection.
   */
  close(): Promise<unknown> | undefined {
    if (!this.connection) return;
    return this.connection.close();
  }

  /**
   * Opens the configured connection, or discovers and connects to the first
   * available device when no connection was configured.
   *
   * A successful connection emits `connect`. A failed attempt can emit
   * `disconnect` and schedule reconnection according to `reconnectInterval`.
   *
   * @returns A promise that resolves when the transport connects.
   * @throws Error If no device is found or the connection cannot be established.
   */
  async connect(): Promise<void> {
    // Explicitly asked for a serial connection (V0.2.X)
    if (this.path || this.port)
      this.connection = new SerialConnection({
        path: this.path,
        port: this.port,
      });
    // Explicitly asked for a websocket connection (V0.1.X)
    else if (this.host)
      this.connection = new WSConnection!({ host: this.host });
    // Autodiscover
    else {
      const devices = await (this.constructor as typeof LoupedeckDevice).list();
      if (devices.length > 0) {
        const { connectionType, ...args } = devices[0];
        this.connection = new (connectionType as DeviceConnectionConstructor)(
          args,
        );
      }
      if (!this.connection) {
        return Promise.reject(this.onDisconnect(new Error("No devices found")));
      }
    }

    const connection = this.connection as DeviceConnection;
    connection.on("connect", this.onConnect.bind(this));
    connection.on("message", this.onReceive.bind(this));
    connection.on("disconnect", this.onDisconnect.bind(this));
    return this.connection.connect();
  }

  /**
   * Attempts a connection for automatic setup or reconnection, suppressing any
   * rejection so the attempt does not produce an unhandled rejection.
   *
   * @returns A promise that resolves after the attempt, whether it succeeds or fails.
   */
  _connectBlind(): Promise<void> {
    return this.connect().catch(() => {});
  }

  /**
   * Writes a raw RGB16-565 pixel buffer to a rectangular display area.
   * Each pixel occupies two bytes in row-major order. Buffers are little-endian
   * except for the Loupedeck CT knob display, which requires big-endian data.
   * Display-specific offsets are added to `x` and `y` before transmission.
   *
   * @param options - Target display and drawing rectangle. Width and height
   * default to the full display; `x` and `y` default to zero.
   * @param options.autoRefresh - Send a draw/refresh command after the write.
   * @defaultValue `true`
   * @param buffer - Exactly `width * height * 2` bytes of RGB16-565 pixels.
   * @returns A promise that resolves after the write and optional refresh are
   * acknowledged. While disconnected, commands are skipped and the promise
   * still resolves.
   * @throws Error If the display is unavailable or the buffer length is incorrect.
   */
  async drawBuffer(
    { id, width, height, x = 0, y = 0, autoRefresh = true }: DrawOptions,
    buffer: Buffer,
  ): Promise<void> {
    const displayInfo = this.displays[id];
    if (!displayInfo)
      throw new Error(`Display '${id}' is not available on this device!`);
    if (!width) width = displayInfo.width;
    if (!height) height = displayInfo.height;
    if (displayInfo.offset) {
      x += displayInfo.offset[0];
      y += displayInfo.offset[1];
    }

    const pixelCount = width * height * 2;
    if (buffer.length !== pixelCount) {
      throw new Error(
        `Expected buffer length of ${pixelCount}, got ${buffer.length}!`,
      );
    }

    // Header with x/y/w/h and display ID
    const header = Buffer.alloc(8);
    header.writeUInt16BE(x, 0);
    header.writeUInt16BE(y, 2);
    header.writeUInt16BE(width, 4);
    header.writeUInt16BE(height, 6);

    // Write to frame buffer
    await this.send(
      COMMANDS.FRAMEBUFF,
      Buffer.concat([displayInfo.id, header, buffer]),
    );

    // Draw to display
    if (autoRefresh) await this.refresh(id);
  }

  /**
   * Draws to a display area with a Canvas 2D callback, converts the result to
   * RGB16-565, and writes it with {@link drawBuffer}. The callback runs
   * synchronously and receives a context sized to the requested drawing area.
   * The optional `canvas` package must be installed.
   *
   * @param options - Target display and drawing rectangle. Width and height
   * default to the full display; other options are forwarded to `drawBuffer`.
   * @param cb - Receives the 2D context, width, and height and performs drawing.
   * @returns A promise that resolves after the write and optional refresh are
   * acknowledged. While disconnected, commands are skipped and it still resolves.
   * @throws Error If the display is unavailable, `canvas` is not installed, or
   * the generated buffer is invalid. Callback exceptions also propagate.
   */
  drawCanvas(
    { id, width, height, ...args }: DrawOptions,
    cb: DrawCallback,
  ): Promise<void> {
    const displayInfo = this.displays[id];
    if (!displayInfo)
      throw new Error(`Display '${id}' is not available on this device!`);
    if (!width) width = displayInfo.width;
    if (!height) height = displayInfo.height;
    if (!canvasModule || !canvasModule.createCanvas) {
      throw new Error(
        "Using callbacks requires the `canvas` library to be installed. Install it using `npm install canvas`.",
      );
    }

    const canvas = canvasModule.createCanvas(width, height);
    const ctx = canvas.getContext("2d", { pixelFormat: "RGB16_565" }); // Loupedeck uses 16-bit (5-6-5) LE RGB colors
    cb(ctx, width, height);
    let buffer: Buffer;
    // If using NodeJS canvas package
    if (canvas.toBuffer) {
      buffer = canvas.toBuffer("raw");
      // If using browser canvas API
    } else {
      const imageData = ctx.getImageData(0, 0, width, height);
      const rgba = imageData.data;
      // Convert from RGBA to RGB16_565
      buffer = rgba2rgb565(rgba, width * height);
    }
    // Swap endianness depending on display
    if (displayInfo.endianness === "be") buffer.swap16();
    return this.drawBuffer({ id, width, height, ...args }, buffer);
  }

  /**
   * Draws a raw pixel buffer over one key on the center display.
   * Keys are indexed from zero in row-major order. The buffer must contain
   * `keySize * keySize * 2` bytes of little-endian RGB16-565 pixels.
   *
   * @param index - Zero-based key index.
   * @param buffer - Exactly `keySize * keySize * 2` bytes of pixel data.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged. While disconnected, commands are skipped and it resolves.
   * @throws Error If the key index is invalid or the buffer length is incorrect.
   */
  drawKey(index: number, buffer: Buffer): Promise<void>;
  /**
   * Draws over one key on the center display with a Canvas 2D callback.
   * Keys are indexed from zero in row-major order; the callback receives a
   * `keySize`-square context. The optional `canvas` package must be installed.
   *
   * @param index - Zero-based key index.
   * @param callback - Receives the 2D context, width, and height and performs drawing.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged. While disconnected, commands are skipped and it resolves.
   * @throws Error If the key index is invalid, `canvas` is unavailable, or the
   * callback throws.
   */
  drawKey(index: number, callback: DrawCallback): Promise<void>;
  /** Dispatches key drawing to the raw-buffer or canvas implementation. */
  drawKey(index: number, cb: Buffer | DrawCallback): Promise<void> {
    // Get offset x/y for key index
    if (index < 0 || index >= this.columns * this.rows)
      throw new Error(`Key ${index} is not a valid key`);
    const width = this.keySize;
    const height = this.keySize;
    const x = this.visibleX[0] + (index % this.columns) * width;
    const y = Math.floor(index / this.columns) * height;
    const options = { id: "center" as const, x, y, width, height };
    if (cb instanceof Buffer) return this.drawBuffer(options, cb);
    return this.drawCanvas(options, cb as DrawCallback);
  }

  /**
   * Fills an entire screen from a raw RGB16-565 pixel buffer.
   * The buffer must contain `display.width * display.height * 2` bytes in
   * row-major order. Data is little-endian except on the CT knob screen, which
   * requires big-endian data.
   *
   * @param id - Screen to draw; it must be available on this device.
   * @param buffer - Full-screen RGB16-565 pixel data.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged. While disconnected, commands are skipped and it resolves.
   * @throws Error If the screen is unavailable or the buffer length is incorrect.
   */
  drawScreen(id: ScreenId, buffer: Buffer): Promise<void>;
  /**
   * Fills an entire screen using a Canvas 2D callback and converts the result
   * to the screen's RGB16-565 byte order. The optional `canvas` package must be
   * installed.
   *
   * @param id - Screen to draw; it must be available on this device.
   * @param callback - Receives a full-screen 2D context, its width, and its height.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged. While disconnected, commands are skipped and it resolves.
   * @throws Error If the screen is unavailable, `canvas` is unavailable, or the
   * callback throws.
   */
  drawScreen(id: ScreenId, callback: DrawCallback): Promise<void>;
  /** Dispatches screen drawing to the raw-buffer or canvas implementation. */
  drawScreen(id: ScreenId, cb: Buffer | DrawCallback): Promise<void> {
    if (cb instanceof Buffer) return this.drawBuffer({ id }, cb);
    return this.drawCanvas({ id }, cb as DrawCallback);
  }

  /**
   * Requests the serial number and firmware version from the device.
   *
   * @returns The device serial number and firmware version string.
   * @throws Error If the device is not connected and ready.
   */
  async getInfo(): Promise<DeviceInfo> {
    if (!this.connection || !this.connection.isReady())
      throw new Error("Not connected!");
    return {
      serial: (await this.send(COMMANDS.SERIAL)) as string,
      version: (await this.send(COMMANDS.VERSION)) as string,
    };
  }

  /**
   * Handles a button/knob press payload and emits `down` or `up`.
   * Payloads shorter than two bytes are ignored.
   *
   * @param buff - Control identifier followed by its pressed/released state.
   */
  onButton(buff: Buffer): void {
    if (buff.length < 2) return;
    const id = BUTTONS[buff[0] as keyof typeof BUTTONS];
    const event = buff[1] === 0x00 ? "down" : "up";
    this.emit(event, { id });
  }

  /**
   * Handles a transport connection and forwards its details as a `connect` event.
   *
   * @param info - Connected transport address information.
   */
  onConnect(info: ConnectInfo): void {
    this.emit("connect", info);
  }

  /**
   * Handles transport disconnection: emits `disconnect`, clears any pending
   * reconnect timer, and clears the current connection. Normal disconnects do
   * not reconnect; abnormal disconnects schedule an attempt when enabled.
   *
   * @param error - Disconnect reason, or a nullish value for a normal close.
   * @returns The error message for an `Error` reason; otherwise `undefined`.
   */
  onDisconnect(error: DisconnectReason): string | undefined {
    this.emit("disconnect", error);
    clearTimeout(this._reconnectTimer);
    this.connection = null;
    // Normal disconnect, do not reconnect
    if (!error) return;
    // Reconnect if desired
    if (this.reconnectInterval) {
      this._reconnectTimer = setTimeout(
        this._connectBlind.bind(this),
        this.reconnectInterval,
      );
    }
    return (error as Error).message;
  }

  /**
   * Decodes an incoming packet, dispatches its payload to the registered command
   * handler, and resolves the matching pending transaction. Without a handler,
   * the complete packet is used as the transaction response.
   *
   * @param buff - Raw packet containing length, command, transaction ID, and payload.
   * @returns The command handler's response, or the original packet if unhandled.
   */
  onReceive(buff: Buffer): PacketResponse {
    const msgLength = buff[0];
    const handler = this.handlers[buff[1]];
    const transactionID = buff[2];
    const response = (
      handler ? handler(buff.slice(3, msgLength)) : buff
    ) as PacketResponse;
    const resolver = this.pendingTransactions[transactionID];
    if (resolver) resolver(response);
    return response;
  }

  /**
   * Handles a knob rotation payload and emits `rotate` with its signed delta.
   *
   * @param buff - Control identifier followed by a signed rotation delta.
   */
  onRotate(buff: Buffer): void {
    const id = BUTTONS[buff[0] as keyof typeof BUTTONS];
    const delta = buff.readInt8(1);
    this.emit("rotate", { id, delta });
  }

  /**
   * Handles a touch payload, resolves its device-specific target, updates the
   * active-touch cache, and emits a touch event. The first move for a touch ID
   * is emitted as `touchstart`; ended touches are removed before emission.
   *
   * @param event - Touch event requested by the packet handler.
   * @param buff - Payload containing big-endian coordinates and the touch ID.
   */
  onTouch(event: "touchstart" | "touchmove" | "touchend", buff: Buffer): void {
    const x = buff.readUInt16BE(1);
    const y = buff.readUInt16BE(3);
    const id = buff[5];

    // Create touch
    const touch: Touch = {
      x,
      y,
      id,
      target: (
        this as unknown as {
          getTarget(x: number, y: number, id?: number): TouchTarget;
        }
      ).getTarget(x, y, id),
    };

    // End touch, remove from local cache
    if (event === "touchend") {
      delete this.touches[touch.id];
    } else {
      // First time seeing this touch, emit touchstart instead of touchmove
      if (!this.touches[touch.id]) event = "touchstart";
      this.touches[touch.id] = touch;
    }

    this.emit(event, {
      touches: Object.values(this.touches),
      changedTouches: [touch],
    });
  }

  /**
   * Asks the device to display the current framebuffer for a screen.
   *
   * @param id - Screen to refresh.
   * @returns A promise resolving with the command response, or `undefined` if
   * the device is not connected and ready.
   */
  refresh(id: ScreenId): Promise<PacketResponse> | undefined {
    const displayInfo = this.displays[id];
    return this.send(COMMANDS.DRAW, displayInfo!.id);
  }

  /**
   * Sends a low-level command and tracks its transaction response.
   * Transaction IDs wrap around at 256 and skip zero. The packet length byte is
   * capped at 255, although the complete header and data buffer are transmitted.
   *
   * @param command - Protocol command byte.
   * @param data - Command payload.
   * @returns A promise resolved when a packet with the transaction ID arrives,
   * or `undefined` if the device is not connected and ready.
   */
  send(
    command: number,
    data: Buffer = Buffer.alloc(0),
  ): Promise<PacketResponse> | undefined {
    if (!this.connection || !this.connection.isReady()) return;
    this.transactionID = (this.transactionID + 1) % 256;
    // Skip transaction ID's of zero since the device seems to ignore them
    if (this.transactionID === 0) this.transactionID++;
    const header = Buffer.alloc(3);
    header[0] = Math.min(3 + data.length, 0xff);
    header[1] = command;
    header[2] = this.transactionID;
    const packet = Buffer.concat([header, data]);
    this.connection.send(packet);
    return new Promise((res) => {
      this.pendingTransactions[this.transactionID] = res;
    });
  }

  /**
   * Sets display brightness from a normalized value.
   * Values are clamped to the `[0, 1]` range, scaled to the device's 0–10
   * range, and rounded to the nearest integer.
   *
   * @param value - Brightness from 0 (off) to 1 (full brightness).
   * @returns A promise resolving with the command response, or `undefined` if
   * the device is not connected and ready.
   */
  setBrightness(value: number): Promise<PacketResponse> | undefined {
    const byte = Math.max(
      0,
      Math.min(MAX_BRIGHTNESS, Math.round(value * MAX_BRIGHTNESS)),
    );
    return this.send(COMMANDS.SET_BRIGHTNESS, Buffer.from([byte]));
  }

  /**
   * Sets the RGB color of a button or knob LED.
   * Alpha in the parsed color is ignored.
   *
   * @param options - LED control and color.
   * @param options.id - Button or knob whose LED should change.
   * @param options.color - Color string accepted by `color-rgba`.
   * @returns A promise resolving with the command response, or `undefined` if
   * the device is not connected and ready.
   * @throws Error If `id` is not a known control.
   */
  setButtonColor({
    id,
    color,
  }: {
    id: ControlId;
    color: string;
  }): Promise<PacketResponse> | undefined {
    const key = Object.keys(BUTTONS).find(
      (k) => BUTTONS[k as unknown as keyof typeof BUTTONS] === id,
    );
    if (!key) throw new Error(`Invalid button ID: ${id}`);
    const [r, g, b] = rgba(color);
    const data = Buffer.from([key as unknown as number, r, g, b]);
    return this.send(COMMANDS.SET_COLOR, data);
  }

  /**
   * Plays a device haptic vibration pattern.
   *
   * @param pattern - Haptic command byte, typically a value from `HAPTIC`.
   * @defaultValue `HAPTIC.SHORT`
   * @returns A promise resolving with the command response, or `undefined` if
   * the device is not connected and ready.
   */
  vibrate(pattern: number = HAPTIC.SHORT): Promise<PacketResponse> | undefined {
    return this.send(COMMANDS.SET_VIBRATION, Buffer.from([pattern]));
  }
}

type LiveDisplays = {
  center: DisplayInfo;
  left: DisplayInfo;
  right: DisplayInfo;
};

type CTDisplays = LiveDisplays & {
  knob: DisplayInfo;
};

/**
 * Loupedeck Live device with three displays and twelve 90×90 keys.
 * Its displays share one framebuffer, addressed through display offsets.
 */
export class LoupedeckLive extends LoupedeckDevice {
  static productId = 0x0004;
  static vendorId = 0x2ec2;
  buttons: ButtonId[] = [0, 1, 2, 3, 4, 5, 6, 7];
  knobs: KnobId[] = [
    "knobCL",
    "knobCR",
    "knobTL",
    "knobTR",
    "knobBL",
    "knobBR",
  ];
  override columns = 4;
  // All displays are addressed as the same screen
  // So we add offsets
  override displays: LiveDisplays = {
    center: {
      id: Buffer.from("\x00M"),
      width: 360,
      height: 270,
      offset: [60, 0],
    },
    left: { id: Buffer.from("\x00M"), width: 60, height: 270 },
    right: {
      id: Buffer.from("\x00M"),
      width: 60,
      height: 270,
      offset: [420, 0],
    },
  };
  override rows = 3;
  type = "Loupedeck Live";
  override visibleX: [number, number] = [0, 480];

  /**
   * Maps a coordinate on the combined 480-pixel-wide touch surface to a target.
   * The left and right strips map to their screens; center coordinates map to a
   * zero-based, row-major key index.
   *
   * @param x - Horizontal touch coordinate.
   * @param y - Vertical touch coordinate.
   * @returns The touched screen, including `key` for the center display.
   */
  getTarget(x: number, y: number): TouchTarget {
    if (x < this.displays.left.width) return { screen: "left" };
    if (x >= this.displays.left.width + this.displays.center.width)
      return { screen: "right" };
    const column = Math.floor((x - this.displays.left.width) / this.keySize);
    const row = Math.floor(y / this.keySize);
    const key = row * this.columns + column;
    return {
      screen: "center",
      key,
    };
  }
}

/**
 * Loupedeck CT (marked V1.00 or V2.00) with independently addressed side and
 * center displays plus a 240×240, big-endian knob display.
 */
export class LoupedeckCT extends LoupedeckLive {
  static override productId = 0x0003;
  override buttons: ButtonId[] = [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    "home",
    "enter",
    "undo",
    "save",
    "keyboard",
    "fnL",
    "a",
    "b",
    "c",
    "d",
    "fnR",
    "e",
  ];
  override displays: CTDisplays = {
    center: { id: Buffer.from("\x00A"), width: 360, height: 270 }, // "A"
    left: { id: Buffer.from("\x00L"), width: 60, height: 270 }, // "L"
    right: { id: Buffer.from("\x00R"), width: 60, height: 270 }, // "R"
    knob: {
      id: Buffer.from("\x00W"),
      width: 240,
      height: 240,
      endianness: "be",
    }, // "W"
  };
  override type = "Loupedeck CT";

  /**
   * Maps a touch to the knob or to the inherited Live screen/key layout.
   *
   * @param x - Horizontal touch coordinate.
   * @param y - Vertical touch coordinate.
   * @param id - Touch identifier; ID 0 targets the knob regardless of coordinates.
   * @returns The knob target for ID 0, otherwise the inherited touch target.
   */
  override getTarget(x: number, y: number, id?: number): TouchTarget {
    if (id === 0) return { screen: "knob" };
    return super.getTarget(x, y);
  }
}

/**
 * Loupedeck CT revision marked V3.00. It uses the Live shared-framebuffer
 * layout for the center and side displays, plus the CT knob display.
 */
export class LoupedeckCTv2 extends LoupedeckCT {
  static override productId = 0x0007;
  // Basically the LoupedeckLive displays + knob
  override displays: CTDisplays = {
    center: {
      id: Buffer.from("\x00M"),
      width: 360,
      height: 270,
      offset: [60, 0],
    },
    left: { id: Buffer.from("\x00M"), width: 60, height: 270 },
    right: {
      id: Buffer.from("\x00M"),
      width: 60,
      height: 270,
      offset: [420, 0],
    },
    knob: {
      id: Buffer.from("\x00W"),
      width: 240,
      height: 240,
      endianness: "be",
    }, // "W"
  };
}

/** Loupedeck Live S with one 480×270 display and fifteen 90×90 keys. */
export class LoupedeckLiveS extends LoupedeckDevice {
  static productId = 0x0006;
  static vendorId = 0x2ec2;
  buttons: ButtonId[] = [0, 1, 2, 3];
  knobs: KnobId[] = ["knobCL", "knobTL"];
  override columns = 5;
  override displays: { center: DisplayInfo } = {
    center: { id: Buffer.from("\x00M"), width: 480, height: 270 },
  };
  override rows = 3;
  type = "Loupedeck Live S";
  override visibleX: [number, number] = [15, 465];

  /**
   * Maps a touch within the visible key area to a zero-based, row-major key.
   * Coordinates outside the horizontal bounds `[15, 465)` have no target.
   *
   * @param x - Horizontal touch coordinate.
   * @param y - Vertical touch coordinate.
   * @returns A center-screen key target, or an empty target outside the visible area.
   */
  getTarget(x: number, y: number): TouchTarget {
    if (x < this.visibleX[0] || x >= this.visibleX[1]) return {};
    const column = Math.floor((x - this.visibleX[0]) / this.keySize);
    const row = Math.floor(y / this.keySize);
    const key = row * this.columns + column;
    return {
      screen: "center",
      key,
    };
  }
}

/** Razer Stream Controller, using the Loupedeck Live layout and protocol. */
export class RazerStreamController extends LoupedeckLive {
  static override productId = 0x0d06;
  static override vendorId = 0x1532;
  override type = "Razer Stream Controller";
}

/**
 * Razer Stream Controller X with one 480×288 display and fifteen 96×96 keys.
 * Key presses also produce synthetic touch events; LED colors and vibration
 * are not supported.
 */
export class RazerStreamControllerX extends LoupedeckDevice {
  static productId = 0x0d09;
  static vendorId = 0x1532;
  type = "Razer Stream Controller X";
  buttons: ButtonId[] = [];
  override columns = 5;
  override displays: { center: DisplayInfo } = {
    center: { id: Buffer.from("\x00M"), width: 480, height: 288 },
  };
  override rows = 3;
  override visibleX: [number, number] = [0, 480];
  override keySize = 96;

  /**
   * Handles a key press/release as the usual `down`/`up` event and additionally
   * emits `touchstart`/`touchend` with a synthetic touch at the key's center.
   * The synthetic target contains only the zero-based key index.
   *
   * @param buff - Key identifier followed by its pressed/released state.
   */
  override onButton(buff: Buffer): void {
    super.onButton(buff);
    const event = buff[1] === 0x00 ? "touchstart" : "touchend";
    const key = BUTTONS[buff[0] as keyof typeof BUTTONS] as number;
    const row = Math.floor(key / this.columns);
    const col = key % this.columns;
    const touch: Touch = {
      id: 0,
      // Add half so touch is in the center of the key
      x: (col + 0.5) * this.keySize,
      y: (row + 0.5) * this.keySize,
      target: { key },
    };
    this.emit(event, {
      touches: event === "touchstart" ? [touch] : [],
      changedTouches: [touch],
    });
  }

  /**
   * Unsupported on this device.
   *
   * @throws Error Always, because key LED colors are not available.
   */
  override setButtonColor(options: { id: ControlId; color: string }): never;
  /** Always throws because this device has no configurable key LEDs. */
  override setButtonColor(): never {
    throw new Error("Setting key color not available on this device!");
  }

  /**
   * Unsupported on this device.
   *
   * @throws Error Always, because vibration is not available.
   */
  override vibrate(pattern?: number): never;
  /** Always throws because this device has no vibration motor. */
  override vibrate(): never {
    throw new Error("Vibration not available on this device!");
  }
}
