import type {
  ConnectInfo,
  ConnectOptions,
  DisconnectReason,
  ListOptions,
} from "./types.js";

export interface TransportConnectOptions extends ConnectOptions {
  timeoutMs?: number;
}

/** Common byte-stream contract implemented by every platform transport. */
export interface DeviceTransport {
  connect(options?: TransportConnectOptions): Promise<void>;
  close(): Promise<void>;
  send(data: Uint8Array, raw?: boolean): Promise<void>;
  isReady(): boolean;
  on(event: "connect", listener: (info: ConnectInfo) => void): unknown;
  on(event: "message", listener: (packet: Uint8Array) => void): unknown;
  on(event: "disconnect", listener: (error: DisconnectReason) => void): unknown;
}

interface ConnectionInfoBase {
  productId: number;
  vendorId: number;
  serialNumber?: string;
}

export interface SerialConnectionInfo extends ConnectionInfoBase {
  kind: "node-serial";
  path: string;
}

export interface WebSerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo():
    | { usbVendorId?: number; usbProductId?: number }
    | Promise<{ usbVendorId?: number; usbProductId?: number }>;
  addEventListener(type: "disconnect", listener: () => void): void;
  removeEventListener(type: "disconnect", listener: () => void): void;
}

export interface WebSerialConnectionInfo extends ConnectionInfoBase {
  kind: "web-serial";
  port: WebSerialPortLike;
}

export interface WSConnectionInfo extends ConnectionInfoBase {
  kind: "websocket";
  host: string;
}

/** Serializable discovery data, except for an explicitly supplied browser port. */
export type DiscoveredConnection =
  | SerialConnectionInfo
  | WebSerialConnectionInfo
  | WSConnectionInfo;

export interface TransportSelector {
  host?: string;
  path?: string;
  port?: WebSerialPortLike;
}

/** Platform-specific discovery and transport construction. */
export interface TransportProvider {
  discover(options?: ListOptions): Promise<DiscoveredConnection[]>;
  create(selector: TransportSelector): DeviceTransport;
  open(descriptor: DiscoveredConnection): DeviceTransport;
}
