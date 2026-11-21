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
  discover(): Promise<Array<SerialConnectionInfo | WebSerialConnectionInfo>>;
}

interface DeviceConnection {
  connect(): Promise<void>;
  on(event: "connect", listener: (info: ConnectInfo) => void): unknown;
  on(event: "message", listener: (packet: Buffer) => void): unknown;
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

  close(): Promise<unknown> | undefined {
    if (!this.connection) return;
    return this.connection.close();
  }

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

  _connectBlind(): Promise<void> {
    return this.connect().catch(() => {});
  }

  // Draw an arbitrary buffer to the device
  // Buffer format must be 16bit 5-6-5 (LE, except BE for the Loupedeck CT Knob screen)
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

  // Create a canvas with correct dimensions and pass back for drawing
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

  // Draw to a specific key index (0-11 on Live, 0-14 on Live S)
  drawKey(index: number, buffer: Buffer): Promise<void>;
  drawKey(index: number, callback: DrawCallback): Promise<void>;
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

  // Draw to a specific screen
  drawScreen(id: ScreenId, buffer: Buffer): Promise<void>;
  drawScreen(id: ScreenId, callback: DrawCallback): Promise<void>;
  drawScreen(id: ScreenId, cb: Buffer | DrawCallback): Promise<void> {
    if (cb instanceof Buffer) return this.drawBuffer({ id }, cb);
    return this.drawCanvas({ id }, cb as DrawCallback);
  }

  async getInfo(): Promise<DeviceInfo> {
    if (!this.connection || !this.connection.isReady())
      throw new Error("Not connected!");
    return {
      serial: (await this.send(COMMANDS.SERIAL)) as string,
      version: (await this.send(COMMANDS.VERSION)) as string,
    };
  }

  onButton(buff: Buffer): void {
    if (buff.length < 2) return;
    const id = BUTTONS[buff[0] as keyof typeof BUTTONS];
    const event = buff[1] === 0x00 ? "down" : "up";
    this.emit(event, { id });
  }

  onConnect(info: ConnectInfo): void {
    this.emit("connect", info);
  }

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

  onRotate(buff: Buffer): void {
    const id = BUTTONS[buff[0] as keyof typeof BUTTONS];
    const delta = buff.readInt8(1);
    this.emit("rotate", { id, delta });
  }

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

  // Display the current framebuffer
  refresh(id: ScreenId): Promise<PacketResponse> | undefined {
    const displayInfo = this.displays[id];
    return this.send(COMMANDS.DRAW, displayInfo!.id);
  }

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

  setBrightness(value: number): Promise<PacketResponse> | undefined {
    const byte = Math.max(
      0,
      Math.min(MAX_BRIGHTNESS, Math.round(value * MAX_BRIGHTNESS)),
    );
    return this.send(COMMANDS.SET_BRIGHTNESS, Buffer.from([byte]));
  }

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

  // Determine touch target based on x/y position
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

// Rear of device says "V1.00" or "V2.00"
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

  // Determine touch target based on x/y position
  override getTarget(x: number, y: number, id?: number): TouchTarget {
    if (id === 0) return { screen: "knob" };
    return super.getTarget(x, y);
  }
}

// Rear of device says "V3.00"
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

  // Determine touch target based on x/y position
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

export class RazerStreamController extends LoupedeckLive {
  static override productId = 0x0d06;
  static override vendorId = 0x1532;
  override type = "Razer Stream Controller";
}

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

  // Emit an extra touchstart event since we are touching keys
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

  override setButtonColor(options: { id: ControlId; color: string }): never;
  override setButtonColor(): never {
    throw new Error("Setting key color not available on this device!");
  }

  override vibrate(pattern?: number): never;
  override vibrate(): never {
    throw new Error("Vibration not available on this device!");
  }
}
