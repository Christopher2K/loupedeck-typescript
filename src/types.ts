import type { CanvasRenderingContext2D } from "canvas";
import type { ControlId } from "./constants.js";

export type ScreenId = "left" | "center" | "right" | "knob";

export interface ConnectInfo {
  address: string | undefined;
}

export interface DeviceInfo {
  serial: string;
  version: string;
}

export interface DisplayInfo {
  id: Buffer;
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

export interface LoupedeckDeviceOptions {
  host?: string;
  path?: string;
  port?: SerialPort;
  autoConnect?: boolean;
  reconnectInterval?: number | false;
}

export interface ListOptions {
  ignoreSerial?: boolean;
  ignoreWebsocket?: boolean;
}

export interface ButtonEvent {
  id: ControlId | undefined;
}

export interface RotateEvent {
  id: ControlId | undefined;
  delta: number;
}

export interface TouchTarget {
  screen?: ScreenId;
  key?: number;
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

export type DisconnectReason = Error | Event | string | null | undefined;

export type LoupedeckDeviceEvents = {
  connect: [info: ConnectInfo];
  disconnect: [error: DisconnectReason];
  down: [event: ButtonEvent];
  up: [event: ButtonEvent];
  rotate: [event: RotateEvent];
  touchstart: [event: TouchEvent];
  touchmove: [event: TouchEvent];
  touchend: [event: TouchEvent];
};

export type PacketResponse = Buffer | string | undefined;
// biome-ignore lint/suspicious/noConfusingVoidType: Event handlers can return without a response.
export type PacketHandler = (payload: Buffer) => PacketResponse | void;
export type TransactionResolver = (response: PacketResponse) => void;
