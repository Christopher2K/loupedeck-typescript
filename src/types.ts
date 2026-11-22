import type { ButtonId, ControlId, KnobId } from "./constants.js";
import type {
  DiscoveredConnection,
  TransportProvider,
  WebSerialPortLike,
} from "./transport.js";

export type ScreenId = "left" | "center" | "right" | "knob";

export type DeviceModel =
  | "loupedeck-live"
  | "loupedeck-live-s"
  | "loupedeck-ct"
  | "loupedeck-ct-v2"
  | "razer-stream-controller"
  | "razer-stream-controller-x";

export type DeviceDescriptor = DiscoveredConnection & { model: DeviceModel };

export interface DeviceSelector {
  serialNumber?: string;
  model?: DeviceModel;
  transport?: DiscoveredConnection["kind"];
}

export interface ConnectInfo {
  address: string | undefined;
}

export interface DeviceInfo {
  serial: string;
  version: string;
}

export interface DisplayInfo {
  id: Uint8Array;
  width: number;
  height: number;
  offset?: [x: number, y: number];
  endianness?: "be";
}

export type DisplayMap = Partial<Record<ScreenId, DisplayInfo>>;

export interface DrawOptions {
  id: ScreenId;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  autoRefresh?: boolean;
}

export type DrawCallback = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

export type CanvasRenderer = (
  width: number,
  height: number,
  callback: DrawCallback,
) => Uint8Array | Promise<Uint8Array>;

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "closing"
  | "closed";

export interface ConnectOptions {
  signal?: AbortSignal;
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DiscoverOptions
  extends LoupedeckDeviceOptions,
    DeviceSelector,
    ListOptions {}

export interface LoupedeckDeviceOptions {
  host?: string;
  path?: string;
  port?: WebSerialPortLike;
  /** @deprecated Constructors never perform I/O; call connect() explicitly. */
  autoConnect?: boolean;
  reconnectInterval?: number | false;
  commandTimeoutMs?: number;
  transportProvider?: TransportProvider;
  descriptor?: DiscoveredConnection;
  canvasRenderer?: CanvasRenderer;
}

export interface ListOptions {
  ignoreSerial?: boolean;
  ignoreWebsocket?: boolean;
  signal?: AbortSignal;
}

export interface ButtonEvent {
  id: ControlId;
}

export interface RotateEvent {
  id: ControlId;
  delta: number;
}

export interface UnknownControlEvent {
  command: number;
  controlId: number;
  data: Uint8Array;
}

export type TouchTarget =
  | { kind: "screen"; screen: ScreenId; key?: never }
  | { kind: "key"; screen?: "center"; key: number }
  | { kind: "none"; screen?: never; key?: never };

export interface DeviceCapabilities {
  readonly model: DeviceModel;
  readonly buttons: readonly ButtonId[];
  readonly knobs: readonly KnobId[];
  readonly screens: readonly ScreenId[];
  readonly keyCount: number;
  readonly keySize: number;
  readonly leds: boolean;
  readonly haptics: boolean;
}

export interface Touch {
  id: number;
  x: number;
  y: number;
  target: TouchTarget;
}

export interface TouchEvent {
  touches: Touch[];
  changedTouches: [Touch];
}

export type DisconnectReason = Error | undefined;

export type LoupedeckDeviceEvents = {
  connect: [info: ConnectInfo];
  disconnect: [error: DisconnectReason];
  protocolError: [error: Error];
  unknownControl: [event: UnknownControlEvent];
  down: [event: ButtonEvent];
  up: [event: ButtonEvent];
  rotate: [event: RotateEvent];
  touchstart: [event: TouchEvent];
  touchmove: [event: TouchEvent];
  touchend: [event: TouchEvent];
};

export type PacketResponse = Uint8Array | string | undefined;
// biome-ignore lint/suspicious/noConfusingVoidType: Event handlers can return without a response.
export type PacketHandler = (payload: Uint8Array) => PacketResponse | void;
