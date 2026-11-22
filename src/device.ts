import rgba from "color-rgba";
import { Emitter as EventEmitter } from "strict-event-emitter";

import {
  concatBytes,
  decodeText,
  encodeText,
  readInt8,
  readUint16BE,
  swap16,
  writeUint16BE,
} from "./bytes.js";
import type {
  ButtonId,
  ControlId,
  HapticPattern,
  KnobId,
} from "./constants.js";
import {
  BUTTONS,
  COMMANDS,
  DEFAULT_RECONNECT_INTERVAL,
  HAPTIC,
  MAX_BRIGHTNESS,
} from "./constants.js";
import {
  asError,
  DeviceClosedError,
  DisconnectedError,
  InvalidArgumentError,
  NotConnectedError,
  ProtocolError,
  UnsupportedCapabilityError,
} from "./errors.js";
import { RequestManager } from "./request-manager.js";
import type {
  DeviceTransport,
  DiscoveredConnection,
  TransportProvider,
  WebSerialPortLike,
} from "./transport.js";
import type {
  CommandOptions,
  ConnectInfo,
  ConnectionState,
  ConnectOptions,
  DeviceCapabilities,
  DeviceInfo,
  DeviceModel,
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
} from "./types.js";

export type { DiscoveredConnection } from "./transport.js";
export type AnyConnection = DeviceTransport;

/**
 * Shared interface for Loupedeck-compatible devices.
 *
 * Emits connection, button, rotation, and touch events. After an abnormal
 * disconnect, reconnection is attempted unless disabled in the constructor.
 * Use a device-specific subclass rather than instantiating this base class.
 */
export abstract class LoupedeckDevice extends EventEmitter<LoupedeckDeviceEvents> {
  declare readonly displays: DisplayMap;
  declare readonly buttons: readonly ButtonId[];
  declare readonly knobs: readonly KnobId[];
  declare readonly model: DeviceModel;
  declare protected columns: number;
  declare protected rows: number;
  declare protected visibleX: [number, number];
  protected abstract getTarget(x: number, y: number, id?: number): TouchTarget;

  protected keySize = 90;
  protected touches: Record<number, Touch>;
  private handlers: Record<number, PacketHandler>;
  readonly reconnectInterval: number | false;
  private host: string | undefined;
  private path: string | undefined;
  private port: WebSerialPortLike | undefined;
  private connection: AnyConnection | null | undefined;

  private _state: ConnectionState = "disconnected";
  private readonly commandTimeoutMs: number;
  private readonly requests = new RequestManager();
  private drawQueue: Promise<void> = Promise.resolve();
  private readonly transportProvider: TransportProvider | undefined;
  private readonly descriptor: DiscoveredConnection | undefined;
  private readonly canvasRenderer: LoupedeckDeviceOptions["canvasRenderer"];
  private connectPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionAbort: AbortController | undefined;
  private generation = 0;

  get state(): ConnectionState {
    return this._state;
  }

  get capabilities(): DeviceCapabilities {
    return Object.freeze({
      model: this.model,
      buttons: Object.freeze([...this.buttons]),
      knobs: Object.freeze([...this.knobs]),
      screens: Object.freeze(Object.keys(this.displays) as ScreenId[]),
      keyCount: this.columns * this.rows,
      keySize: this.keySize,
      leds: this.buttons.length + this.knobs.length > 0,
      haptics: this.model !== "razer-stream-controller-x",
    });
  }

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
  static list(_options: ListOptions = {}): Promise<DiscoveredConnection[]> {
    return Promise.reject(
      new NotConnectedError(
        "No transport provider configured; use the node or browser entry point",
      ),
    );
  }

  /**
   * Creates a disconnected, side-effect-free device interface.
   * A serial `path` or `port` selects a serial connection; otherwise `host`
   * selects WebSocket. With no selector, connect() discovers a matching device.
   *
   * @param options - Connection and reconnection options.
   * @param options.host - WebSocket host or IP address for firmware 0.1.x.
   * @param options.path - Serial device path for firmware 0.2.x.
   * @param options.port - Browser Web Serial port for firmware 0.2.x.
   * @param options.reconnectInterval - Milliseconds to wait before reconnecting
   * after an abnormal disconnect, or `false` to disable automatic reconnection.
   * @defaultValue `DEFAULT_RECONNECT_INTERVAL` (3000 ms)
   */
  constructor({
    host,
    path,
    port,
    reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
    commandTimeoutMs = 3000,
    transportProvider,
    descriptor,
    canvasRenderer,
  }: LoupedeckDeviceOptions = {}) {
    super();
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new RangeError("commandTimeoutMs must be a positive finite number");
    }
    if (
      reconnectInterval !== false &&
      (!Number.isFinite(reconnectInterval) || reconnectInterval < 0)
    ) {
      throw new RangeError(
        "reconnectInterval must be false or a nonnegative finite number",
      );
    }
    this.commandTimeoutMs = commandTimeoutMs;
    this.transportProvider = transportProvider;
    this.descriptor = descriptor;
    this.canvasRenderer = canvasRenderer;
    this.touches = {};
    this.handlers = {
      [COMMANDS.BUTTON_PRESS]: this.onButton.bind(this),
      [COMMANDS.KNOB_ROTATE]: this.onRotate.bind(this),
      [COMMANDS.SERIAL]: (buff) => decodeText(buff).trim(),
      [COMMANDS.TOUCH]: this.onTouch.bind(this, "touchmove"),
      [COMMANDS.TOUCH_END]: this.onTouch.bind(this, "touchend"),
      [COMMANDS.VERSION]: (buff) => `${buff[0]}.${buff[1]}.${buff[2]}`,
      [COMMANDS.TOUCH_CT]: this.onTouch.bind(this, "touchmove"),
      [COMMANDS.TOUCH_END_CT]: this.onTouch.bind(this, "touchend"),
    };
    // How long between reconnect attempts
    this.reconnectInterval = reconnectInterval;
    // Host for websocket connections
    this.host = host;
    // Path or port for serial connections
    this.path = path;
    this.port = port;
    // Construction is intentionally side-effect-free. Call connect() when ready.
  }

  /** Close the device, cancel reconnects, and reject outstanding commands. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this._state === "closed") return Promise.resolve();

    const transport = this.connection;
    const shouldEmitDisconnect =
      this._state === "connected" || this._state === "connecting";
    this._state = "closing";
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.connectionAbort?.abort(new DeviceClosedError());
    this.requests.rejectAll(new DeviceClosedError());
    this.touches = {};

    this.closePromise = (async () => {
      try {
        await transport?.close();
      } finally {
        this.connection = null;
        this.connectionAbort = undefined;
        this._state = "closed";
        if (shouldEmitDisconnect) this.emit("disconnect", undefined);
      }
    })();
    return this.closePromise;
  }

  /** Open one shared connection attempt and resolve once the device is ready. */
  connect({ signal }: ConnectOptions = {}): Promise<void> {
    if (this._state === "connected") return Promise.resolve();
    if (this._state === "connecting") return this.connectPromise!;
    if (this._state === "closing")
      return this.closePromise!.then(() => {
        throw new DeviceClosedError();
      });
    if (this._state === "closed")
      return Promise.reject(new DeviceClosedError());

    clearTimeout(this.reconnectTimer);
    const abortController = new AbortController();
    this.connectionAbort = abortController;
    const abort = () => abortController.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const generation = ++this.generation;
    this._state = "connecting";
    const attempt = this.openConnection(
      generation,
      abortController.signal,
    ).finally(() => {
      signal?.removeEventListener("abort", abort);
    });
    this.connectPromise = attempt;
    return attempt;
  }

  private async openConnection(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const provider = this.transportProvider;
      if (!provider) {
        throw new NotConnectedError(
          "No transport provider configured; use the node or browser entry point",
        );
      }

      let transport: DeviceTransport;
      if (this.descriptor) {
        transport = provider.open(this.descriptor);
      } else if (this.path || this.port || this.host) {
        transport = provider.create({
          path: this.path,
          port: this.port,
          host: this.host,
        });
      } else {
        const devices = await provider.discover({ signal });
        if (signal.aborted) {
          throw new DeviceClosedError(undefined, { cause: signal.reason });
        }
        const deviceClass = this.constructor as {
          productId?: number;
          vendorId?: number;
        };
        const descriptor = devices.find(
          (candidate) =>
            (deviceClass.productId === undefined ||
              candidate.productId === deviceClass.productId) &&
            (deviceClass.vendorId === undefined ||
              candidate.vendorId === deviceClass.vendorId),
        );
        if (!descriptor) throw new NotConnectedError("No devices found");
        transport = provider.open(descriptor);
      }

      if (generation !== this.generation || signal.aborted) {
        throw new DeviceClosedError(undefined, { cause: signal.reason });
      }
      this.connection = transport;
      const connection = transport;
      connection.on("connect", (info) => {
        if (generation !== this.generation) return;
        this._state = "connected";
        this.onConnect(info);
      });
      connection.on("message", (packet) => {
        if (generation !== this.generation) return;
        try {
          this.onReceive(packet);
        } catch (error) {
          this.emit("protocolError", asError(error, "Invalid device packet"));
        }
      });
      connection.on("disconnect", (error) => {
        this.handleDisconnect(error, generation);
      });
      await transport.connect({ signal });
      if (generation !== this.generation || signal.aborted) {
        throw new DeviceClosedError(undefined, { cause: signal.reason });
      }
      this._state = "connected";
    } catch (error) {
      const reason = asError(error, "Connection failed");
      if (generation === this.generation) {
        this.connection = null;
        this._state = "disconnected";
        this.handleDisconnect(reason, generation, !signal.aborted);
      }
      throw reason;
    } finally {
      if (generation === this.generation) {
        this.connectPromise = undefined;
        this.connectionAbort = undefined;
      }
    }
  }

  private _connectBlind(): void {
    void this.connect().catch(() => {});
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
   * acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the display is unavailable or the buffer length is incorrect.
   */
  drawBuffer<D extends LoupedeckDevice>(
    this: D,
    options: Omit<DrawOptions, "id"> & {
      id: ScreenId & keyof D["displays"];
    },
    buffer: Uint8Array,
    commandOptions: CommandOptions = {},
  ): Promise<void> {
    const operation = this.drawQueue.then(() =>
      this.performDraw(options, buffer, commandOptions),
    );
    this.drawQueue = operation.catch(() => {});
    return operation;
  }

  private async performDraw(
    options: DrawOptions,
    buffer: Uint8Array,
    commandOptions: CommandOptions,
  ): Promise<void> {
    const {
      id,
      width: requestedWidth,
      height: requestedHeight,
      x = 0,
      y = 0,
      autoRefresh = true,
    } = options;
    let width = requestedWidth;
    let height = requestedHeight;
    const displayInfo = this.displays[id];
    if (!displayInfo) throw new UnsupportedCapabilityError(`Display '${id}'`);
    width ??= displayInfo.width;
    height ??= displayInfo.height;
    validateDrawRectangle(x, y, width, height, displayInfo);
    if (
      !ArrayBuffer.isView(buffer) ||
      typeof buffer.length !== "number" ||
      buffer.BYTES_PER_ELEMENT !== 1
    ) {
      throw new InvalidArgumentError("Pixel data must be a Uint8Array");
    }

    const pixelCount = width * height * 2;
    if (buffer.length !== pixelCount) {
      throw new InvalidArgumentError(
        `Expected buffer length of ${pixelCount}, got ${buffer.length}!`,
      );
    }

    const drawX = x + (displayInfo.offset?.[0] ?? 0);
    const drawY = y + (displayInfo.offset?.[1] ?? 0);
    const header = new Uint8Array(8);
    writeUint16BE(header, drawX, 0);
    writeUint16BE(header, drawY, 2);
    writeUint16BE(header, width, 4);
    writeUint16BE(header, height, 6);

    await this.send(
      COMMANDS.FRAMEBUFF,
      concatBytes(displayInfo.id, header, buffer),
      commandOptions,
    );
    if (autoRefresh) await this.refresh(id, commandOptions);
  }

  /**
   * Draws to a display area with a Canvas 2D callback, converts the result to
   * RGB16-565, and writes it with {@link drawBuffer}. The callback runs
   * synchronously and receives a context sized to the requested drawing area.
   * The platform entry point supplies the appropriate canvas renderer.
   *
   * @param options - Target display and drawing rectangle. Width and height
   * default to the full display; other options are forwarded to `drawBuffer`.
   * @param cb - Receives the 2D context, width, and height and performs drawing.
   * @returns A promise that resolves after the write and optional refresh are
   * acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the display is unavailable, `canvas` is not installed, or
   * the generated buffer is invalid. Callback exceptions also propagate.
   */
  async drawCanvas<D extends LoupedeckDevice>(
    this: D,
    options: Omit<DrawOptions, "id"> & {
      id: ScreenId & keyof D["displays"];
    },
    cb: DrawCallback,
    commandOptions: CommandOptions = {},
  ): Promise<void> {
    const {
      id,
      width: requestedWidth,
      height: requestedHeight,
      x = 0,
      y = 0,
      ...args
    } = options;
    let width = requestedWidth;
    let height = requestedHeight;
    const displayInfo = this.displays[id];
    if (!displayInfo) throw new UnsupportedCapabilityError(`Display '${id}'`);
    width ??= displayInfo.width;
    height ??= displayInfo.height;
    validateDrawRectangle(x, y, width, height, displayInfo);
    if (!this.canvasRenderer) {
      throw new UnsupportedCapabilityError("Canvas drawing");
    }

    const rendered = await this.canvasRenderer(width, height, cb);
    const buffer = rendered.slice();
    if (displayInfo.endianness === "be") swap16(buffer);
    await this.drawBuffer(
      { id, width, height, x, y, ...args },
      buffer,
      commandOptions,
    );
  }

  /**
   * Draws a raw pixel buffer over one key on the center display.
   * Keys are indexed from zero in row-major order. The buffer must contain
   * `keySize * keySize * 2` bytes of little-endian RGB16-565 pixels.
   *
   * @param index - Zero-based key index.
   * @param buffer - Exactly `keySize * keySize * 2` bytes of pixel data.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the key index is invalid or the buffer length is incorrect.
   */
  drawKey(
    index: number,
    buffer: Uint8Array,
    options?: CommandOptions,
  ): Promise<void>;
  /**
   * Draws over one key on the center display with a Canvas 2D callback.
   * Keys are indexed from zero in row-major order; the callback receives a
   * `keySize`-square context. The platform entry point supplies the appropriate canvas renderer.
   *
   * @param index - Zero-based key index.
   * @param callback - Receives the 2D context, width, and height and performs drawing.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the key index is invalid, `canvas` is unavailable, or the
   * callback throws.
   */
  drawKey(
    index: number,
    callback: DrawCallback,
    options?: CommandOptions,
  ): Promise<void>;
  /** Dispatches key drawing to the raw-buffer or canvas implementation. */
  async drawKey(
    index: number,
    cb: Uint8Array | DrawCallback,
    commandOptions: CommandOptions = {},
  ): Promise<void> {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.columns * this.rows
    ) {
      throw new InvalidArgumentError(`Key ${index} is not a valid key`);
    }
    const width = this.keySize;
    const height = this.keySize;
    const x = this.visibleX[0] + (index % this.columns) * width;
    const y = Math.floor(index / this.columns) * height;
    const options = { id: "center" as const, x, y, width, height };
    if (typeof cb === "function") {
      await this.drawCanvas(options, cb, commandOptions);
    } else {
      await this.drawBuffer(options, cb, commandOptions);
    }
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
   * are acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the screen is unavailable or the buffer length is incorrect.
   */
  drawScreen<D extends LoupedeckDevice>(
    this: D,
    id: ScreenId & keyof D["displays"],
    buffer: Uint8Array,
    options?: CommandOptions,
  ): Promise<void>;
  /**
   * Fills an entire screen using a Canvas 2D callback and converts the result
   * to the screen's RGB16-565 byte order. The optional `canvas` package must be
   * installed.
   *
   * @param id - Screen to draw; it must be available on this device.
   * @param callback - Receives a full-screen 2D context, its width, and its height.
   * @returns A promise that resolves after the framebuffer write and refresh
   * are acknowledged, or rejects if disconnected or not acknowledged in time.
   * @throws Error If the screen is unavailable, `canvas` is unavailable, or the
   * callback throws.
   */
  drawScreen<D extends LoupedeckDevice>(
    this: D,
    id: ScreenId & keyof D["displays"],
    callback: DrawCallback,
    options?: CommandOptions,
  ): Promise<void>;
  /** Dispatches screen drawing to the raw-buffer or canvas implementation. */
  async drawScreen<D extends LoupedeckDevice>(
    this: D,
    id: ScreenId & keyof D["displays"],
    cb: Uint8Array | DrawCallback,
    commandOptions: CommandOptions = {},
  ): Promise<void> {
    if (typeof cb === "function") {
      await this.drawCanvas({ id }, cb, commandOptions);
    } else {
      await this.drawBuffer({ id }, cb, commandOptions);
    }
  }

  /**
   * Requests the serial number and firmware version from the device.
   *
   * @returns The device serial number and firmware version string.
   * @throws Error If the device is not connected and ready.
   */
  async getInfo(options: CommandOptions = {}): Promise<DeviceInfo> {
    if (!this.connection || !this.connection.isReady()) {
      throw new NotConnectedError();
    }
    const serial = await this.send(COMMANDS.SERIAL, new Uint8Array(), options);
    const version = await this.send(
      COMMANDS.VERSION,
      new Uint8Array(),
      options,
    );
    if (typeof serial !== "string" || typeof version !== "string") {
      throw new ProtocolError(
        "Device information response had an invalid type",
      );
    }
    return { serial, version };
  }

  /**
   * Handles a button/knob press payload and emits `down` or `up`.
   * Payloads shorter than two bytes are ignored.
   *
   * @param buff - Control identifier followed by its pressed/released state.
   */
  protected onButton(buff: Uint8Array): void {
    if (buff.length < 2) return;
    const controlId = buff[0]!;
    const id: ControlId | undefined =
      BUTTONS[controlId as keyof typeof BUTTONS];
    if (id === undefined) {
      this.emit("unknownControl", {
        command: COMMANDS.BUTTON_PRESS,
        controlId,
        data: buff,
      });
      return;
    }
    const event = buff[1] === 0x00 ? "down" : "up";
    this.emit(event, { id });
  }

  /**
   * Handles a transport connection and forwards its details as a `connect` event.
   *
   * @param info - Connected transport address information.
   */
  private onConnect(info: ConnectInfo): void {
    this.emit("connect", info);
  }

  private handleDisconnect(
    reason: DisconnectReason,
    generation: number,
    allowReconnect = true,
  ): void {
    if (generation !== this.generation || this._state === "closed") return;
    const error = reason
      ? asError(reason, "Transport disconnected")
      : undefined;
    clearTimeout(this.reconnectTimer);
    this.connection = null;
    this._state = "disconnected";
    this.touches = {};
    this.requests.rejectAll(
      new DisconnectedError(error?.message ?? "The device disconnected", {
        cause: error,
      }),
      generation,
    );
    this.emit("disconnect", error);

    if (error && allowReconnect && this.reconnectInterval !== false) {
      this.reconnectTimer = setTimeout(() => {
        if (this._state === "disconnected") this._connectBlind();
      }, this.reconnectInterval);
    }
  }

  /**
   * Decodes an incoming packet, dispatches its payload to the registered command
   * handler, and resolves the matching pending transaction. Without a handler,
   * the complete packet is used as the transaction response.
   *
   * @param buff - Raw packet containing length, command, transaction ID, and payload.
   * @returns The command handler's response, or the original packet if unhandled.
   */
  private onReceive(buff: Uint8Array): PacketResponse {
    if (buff.length < 3) {
      throw new ProtocolError("Packet is shorter than the protocol header");
    }
    const msgLength = buff[0];
    const command = buff[1];
    const transactionID = buff[2];
    if (msgLength !== buff.length) {
      throw new ProtocolError(
        `Packet declares ${msgLength} bytes but contains ${buff.length}`,
      );
    }
    const handler = this.handlers[command];
    let response: PacketResponse;
    try {
      response = (handler ? handler(buff.subarray(3)) : buff) as PacketResponse;
    } catch (error) {
      const protocolError = new ProtocolError("Invalid command payload", {
        cause: error,
      });
      this.requests.reject(transactionID, protocolError);
      throw protocolError;
    }
    this.requests.resolve(transactionID, command, response);
    return response;
  }

  /**
   * Handles a knob rotation payload and emits `rotate` with its signed delta.
   *
   * @param buff - Control identifier followed by a signed rotation delta.
   */
  private onRotate(buff: Uint8Array): void {
    if (buff.length < 2)
      throw new ProtocolError("Rotation payload is too short");
    const controlId = buff[0]!;
    const id: ControlId | undefined =
      BUTTONS[controlId as keyof typeof BUTTONS];
    if (id === undefined) {
      this.emit("unknownControl", {
        command: COMMANDS.KNOB_ROTATE,
        controlId,
        data: buff,
      });
      return;
    }
    const delta = readInt8(buff, 1);
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
  private onTouch(
    event: "touchstart" | "touchmove" | "touchend",
    buff: Uint8Array,
  ): void {
    if (buff.length < 6) throw new ProtocolError("Touch payload is too short");
    const x = readUint16BE(buff, 1);
    const y = readUint16BE(buff, 3);
    const id = buff[5];

    // Create touch
    const touch: Touch = {
      x,
      y,
      id,
      target: this.getTarget(x, y, id),
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
   * @returns A promise that resolves after acknowledgement or rejects on failure.
   */
  private async refresh<D extends LoupedeckDevice>(
    this: D,
    id: ScreenId & keyof D["displays"],
    options: CommandOptions = {},
  ): Promise<void> {
    const displayInfo = this.displays[id];
    if (!displayInfo) throw new UnsupportedCapabilityError(`Display '${id}'`);
    await this.send(COMMANDS.DRAW, displayInfo.id, options);
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
  private send(
    command: number,
    data: Uint8Array = new Uint8Array(),
    { signal, timeoutMs = this.commandTimeoutMs }: CommandOptions = {},
  ): Promise<PacketResponse> {
    const connection = this.connection;
    if (!connection || !connection.isReady()) {
      return Promise.reject(new NotConnectedError());
    }
    if (!Number.isInteger(command) || command < 0 || command > 0xff) {
      return Promise.reject(new InvalidArgumentError("Command must be a byte"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError("timeoutMs must be positive"));
    }
    const generation = this.generation;
    return this.requests.request({
      command,
      generation,
      signal,
      timeoutMs,
      write: (transactionId) => {
        const header = new Uint8Array(3);
        header[0] = Math.min(3 + data.length, 0xff);
        header[1] = command;
        header[2] = transactionId;
        return connection.send(concatBytes(header, data));
      },
    });
  }

  /**
   * Sets display brightness from a normalized value.
   * Values are clamped to the `[0, 1]` range, scaled to the device's 0–10
   * range, and rounded to the nearest integer.
   *
   * @param value - Brightness from 0 (off) to 1 (full brightness).
   * @returns A promise that resolves after acknowledgement or rejects on failure.
   */
  async setBrightness(
    value: number,
    options: CommandOptions = {},
  ): Promise<void> {
    if (!Number.isFinite(value)) {
      throw new InvalidArgumentError("Brightness must be a finite number");
    }
    const byte = Math.max(
      0,
      Math.min(MAX_BRIGHTNESS, Math.round(value * MAX_BRIGHTNESS)),
    );
    await this.send(COMMANDS.SET_BRIGHTNESS, Uint8Array.from([byte]), options);
  }

  /**
   * Sets the RGB color of a button or knob LED.
   * Alpha in the parsed color is ignored.
   *
   * @param options - LED control and color.
   * @param options.id - Button or knob whose LED should change.
   * @param options.color - Color string accepted by `color-rgba`.
   * @returns A promise that resolves after acknowledgement or rejects on failure.
   * @throws Error If `id` is not a known control.
   */
  async setButtonColor(
    { id, color }: { id: ControlId; color: string },
    options: CommandOptions = {},
  ): Promise<void> {
    const key = Object.keys(BUTTONS).find(
      (k) => BUTTONS[k as unknown as keyof typeof BUTTONS] === id,
    );
    if (!key) throw new InvalidArgumentError(`Invalid button ID: ${id}`);
    if (![...this.buttons, ...this.knobs].includes(id)) {
      throw new UnsupportedCapabilityError(`LED control '${id}'`);
    }
    const [r, g, b] = rgba(color);
    if (![r, g, b].every((channel) => Number.isFinite(channel))) {
      throw new InvalidArgumentError(`Invalid color: ${color}`);
    }
    await this.send(
      COMMANDS.SET_COLOR,
      Uint8Array.from([Number(key), r, g, b]),
      options,
    );
  }

  /**
   * Plays a device haptic vibration pattern.
   *
   * @param pattern - Haptic command byte, typically a value from `HAPTIC`.
   * @defaultValue `HAPTIC.SHORT`
   * @returns A promise that resolves after acknowledgement or rejects on failure.
   */
  async vibrate(
    pattern: HapticPattern = HAPTIC.SHORT,
    options: CommandOptions = {},
  ): Promise<void> {
    await this.send(
      COMMANDS.SET_VIBRATION,
      Uint8Array.from([pattern]),
      options,
    );
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
  override readonly buttons: readonly ButtonId[] = [0, 1, 2, 3, 4, 5, 6, 7];
  override readonly knobs: readonly KnobId[] = [
    "knobCL",
    "knobCR",
    "knobTL",
    "knobTR",
    "knobBL",
    "knobBR",
  ];
  override readonly model: DeviceModel = "loupedeck-live";
  protected override columns = 4;
  // All displays are addressed as the same screen
  // So we add offsets
  override readonly displays: LiveDisplays = {
    center: {
      id: encodeText("\x00M"),
      width: 360,
      height: 270,
      offset: [60, 0],
    },
    left: { id: encodeText("\x00M"), width: 60, height: 270 },
    right: {
      id: encodeText("\x00M"),
      width: 60,
      height: 270,
      offset: [420, 0],
    },
  };
  protected override rows = 3;
  type = "Loupedeck Live";
  protected override visibleX: [number, number] = [0, 480];

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
    if (x < this.displays.left.width) {
      return { kind: "screen", screen: "left" };
    }
    if (x >= this.displays.left.width + this.displays.center.width) {
      return { kind: "screen", screen: "right" };
    }
    const column = Math.floor((x - this.displays.left.width) / this.keySize);
    const row = Math.floor(y / this.keySize);
    const key = row * this.columns + column;
    return {
      kind: "key",
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
  override readonly model: DeviceModel = "loupedeck-ct";
  override readonly buttons: readonly ButtonId[] = [
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
  override readonly knobs: readonly KnobId[] = [
    "knobCT",
    "knobCL",
    "knobCR",
    "knobTL",
    "knobTR",
    "knobBL",
    "knobBR",
  ];
  override readonly displays: CTDisplays = {
    center: { id: encodeText("\x00A"), width: 360, height: 270 }, // "A"
    left: { id: encodeText("\x00L"), width: 60, height: 270 }, // "L"
    right: { id: encodeText("\x00R"), width: 60, height: 270 }, // "R"
    knob: {
      id: encodeText("\x00W"),
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
    if (id === 0) return { kind: "screen", screen: "knob" };
    return super.getTarget(x, y);
  }
}

/**
 * Loupedeck CT revision marked V3.00. It uses the Live shared-framebuffer
 * layout for the center and side displays, plus the CT knob display.
 */
export class LoupedeckCTv2 extends LoupedeckCT {
  static override productId = 0x0007;
  override readonly model: DeviceModel = "loupedeck-ct-v2";
  override type = "Loupedeck CT v2";
  // Basically the LoupedeckLive displays + knob
  override readonly displays: CTDisplays = {
    center: {
      id: encodeText("\x00M"),
      width: 360,
      height: 270,
      offset: [60, 0],
    },
    left: { id: encodeText("\x00M"), width: 60, height: 270 },
    right: {
      id: encodeText("\x00M"),
      width: 60,
      height: 270,
      offset: [420, 0],
    },
    knob: {
      id: encodeText("\x00W"),
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
  override readonly model: DeviceModel = "loupedeck-live-s";
  override readonly buttons: readonly ButtonId[] = [0, 1, 2, 3, 4];
  override readonly knobs: readonly KnobId[] = ["knobCL", "knobTL"];
  protected override columns = 5;
  override readonly displays: { center: DisplayInfo } = {
    center: { id: encodeText("\x00M"), width: 480, height: 270 },
  };
  protected override rows = 3;
  type = "Loupedeck Live S";
  protected override visibleX: [number, number] = [15, 465];

  /**
   * Maps a touch within the visible key area to a zero-based, row-major key.
   * Coordinates outside the horizontal bounds `[15, 465)` have no target.
   *
   * @param x - Horizontal touch coordinate.
   * @param y - Vertical touch coordinate.
   * @returns A center-screen key target, or an empty target outside the visible area.
   */
  getTarget(x: number, y: number): TouchTarget {
    if (x < this.visibleX[0] || x >= this.visibleX[1]) {
      return { kind: "none" };
    }
    const column = Math.floor((x - this.visibleX[0]) / this.keySize);
    const row = Math.floor(y / this.keySize);
    const key = row * this.columns + column;
    return {
      kind: "key",
      screen: "center",
      key,
    };
  }
}

/** Razer Stream Controller, using the Loupedeck Live layout and protocol. */
export class RazerStreamController extends LoupedeckLive {
  static override productId = 0x0d06;
  static override vendorId = 0x1532;
  override readonly model: DeviceModel = "razer-stream-controller";
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
  override readonly model: DeviceModel = "razer-stream-controller-x";
  type = "Razer Stream Controller X";
  override readonly buttons: readonly ButtonId[] = [];
  override readonly knobs: readonly KnobId[] = [];
  protected override columns = 5;
  override readonly displays: { center: DisplayInfo } = {
    center: { id: encodeText("\x00M"), width: 480, height: 288 },
  };
  protected override rows = 3;
  protected override visibleX: [number, number] = [0, 480];
  protected override keySize = 96;

  getTarget(x: number, y: number): TouchTarget {
    const column = Math.floor(x / this.keySize);
    const row = Math.floor(y / this.keySize);
    if (column < 0 || column >= this.columns || row < 0 || row >= this.rows) {
      return { kind: "none" };
    }
    return { kind: "key", key: row * this.columns + column };
  }

  /**
   * Handles a key press/release as the usual `down`/`up` event and additionally
   * emits `touchstart`/`touchend` with a synthetic touch at the key's center.
   * The synthetic target contains only the zero-based key index.
   *
   * @param buff - Key identifier followed by its pressed/released state.
   */
  protected override onButton(buff: Uint8Array): void {
    if (buff.length < 2) throw new ProtocolError("Button payload is too short");
    const key = BUTTONS[buff[0] as keyof typeof BUTTONS];
    if (typeof key !== "number") {
      super.onButton(buff);
      return;
    }
    super.onButton(buff);
    const event = buff[1] === 0x00 ? "touchstart" : "touchend";
    const row = Math.floor(key / this.columns);
    const col = key % this.columns;
    const touch: Touch = {
      id: key + 1,
      x: (col + 0.5) * this.keySize,
      y: (row + 0.5) * this.keySize,
      target: { kind: "key", key },
    };
    if (event === "touchstart") this.touches[touch.id] = touch;
    else delete this.touches[touch.id];
    this.emit(event, {
      touches: Object.values(this.touches),
      changedTouches: [touch],
    });
  }

  /**
   * Unsupported on this device.
   *
   * @throws Error Always, because key LED colors are not available.
   */
  override async setButtonColor(
    _options?: { id: ControlId; color: string },
    _commandOptions?: CommandOptions,
  ): Promise<never> {
    throw new UnsupportedCapabilityError("Button colors");
  }

  /**
   * Unsupported on this device.
   *
   * @throws Error Always, because vibration is not available.
   */
  override async vibrate(
    _pattern?: HapticPattern,
    _options?: CommandOptions,
  ): Promise<never> {
    throw new UnsupportedCapabilityError("Vibration");
  }
}

function validateDrawRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  display: DisplayInfo,
): void {
  if (![x, y, width, height].every(Number.isInteger)) {
    throw new InvalidArgumentError(
      "Draw coordinates and dimensions must be integers",
    );
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new InvalidArgumentError(
      "Draw rectangles must have positive dimensions and nonnegative coordinates",
    );
  }
  if (x + width > display.width || y + height > display.height) {
    throw new InvalidArgumentError(
      `Draw rectangle ${x},${y} ${width}x${height} exceeds display bounds ${display.width}x${display.height}`,
    );
  }
}
