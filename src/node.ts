import LoupedeckSerialConnection from "./connections/serial.js";
import LoupedeckWSConnection from "./connections/ws.js";
import {
  LoupedeckCT as CoreLoupedeckCT,
  LoupedeckCTv2 as CoreLoupedeckCTv2,
  LoupedeckLive as CoreLoupedeckLive,
  LoupedeckLiveS as CoreLoupedeckLiveS,
  RazerStreamController as CoreRazerStreamController,
  RazerStreamControllerX as CoreRazerStreamControllerX,
} from "./device.js";
import {
  createFromDescriptor,
  type DeviceDefinition,
  discoverDevice,
  listSupportedDevices,
  openDiscoveredDevice,
} from "./discovery.js";
import { NotConnectedError, OperationAbortedError } from "./errors.js";
import { renderNodeCanvas } from "./node-canvas.js";
import type {
  DiscoveredConnection,
  TransportProvider,
  TransportSelector,
} from "./transport.js";
import type {
  DeviceDescriptor,
  DiscoverOptions,
  ListOptions,
  LoupedeckDeviceOptions,
} from "./types.js";

export const nodeTransportProvider: TransportProvider = {
  async discover({
    ignoreSerial = false,
    ignoreWebsocket = false,
    signal,
  }: ListOptions = {}): Promise<DiscoveredConnection[]> {
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    const attempts: Promise<DiscoveredConnection[]>[] = [];
    if (!ignoreSerial) attempts.push(LoupedeckSerialConnection.discover());
    if (!ignoreWebsocket) {
      attempts.push(Promise.resolve(LoupedeckWSConnection.discover()));
    }
    const results = await Promise.allSettled(attempts);
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    const devices = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (
      !devices.length &&
      failures.length === results.length &&
      failures.length
    ) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "All transport discovery attempts failed",
      );
    }
    return devices;
  },
  create(selector: TransportSelector) {
    if (selector.path)
      return new LoupedeckSerialConnection({ path: selector.path });
    if (selector.host)
      return new LoupedeckWSConnection({ host: selector.host });
    throw new NotConnectedError("A serial path or WebSocket host is required");
  },
  open(descriptor: DiscoveredConnection) {
    switch (descriptor.kind) {
      case "node-serial":
        return new LoupedeckSerialConnection({ path: descriptor.path });
      case "websocket":
        return new LoupedeckWSConnection({ host: descriptor.host });
      case "web-serial":
        throw new NotConnectedError(
          "Web Serial is unavailable in the Node entry point",
        );
    }
  },
};

function nodeOptions(options: LoupedeckDeviceOptions): LoupedeckDeviceOptions {
  return {
    ...options,
    transportProvider: options.transportProvider ?? nodeTransportProvider,
    canvasRenderer: options.canvasRenderer ?? renderNodeCanvas,
  };
}

export class LoupedeckLive extends CoreLoupedeckLive {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export class LoupedeckLiveS extends CoreLoupedeckLiveS {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export class LoupedeckCT extends CoreLoupedeckCT {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export class LoupedeckCTv2 extends CoreLoupedeckCTv2 {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export class RazerStreamController extends CoreRazerStreamController {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export class RazerStreamControllerX extends CoreRazerStreamControllerX {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(nodeOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return nodeTransportProvider.discover(options);
  }
}

export type SupportedDevice =
  | LoupedeckLive
  | LoupedeckLiveS
  | LoupedeckCT
  | LoupedeckCTv2
  | RazerStreamController
  | RazerStreamControllerX;

const definitions: readonly DeviceDefinition<SupportedDevice>[] = [
  {
    model: "loupedeck-live",
    productId: 0x0004,
    vendorId: 0x2ec2,
    DeviceClass: LoupedeckLive,
  },
  {
    model: "loupedeck-live-s",
    productId: 0x0006,
    vendorId: 0x2ec2,
    DeviceClass: LoupedeckLiveS,
  },
  {
    model: "loupedeck-ct",
    productId: 0x0003,
    vendorId: 0x2ec2,
    DeviceClass: LoupedeckCT,
  },
  {
    model: "loupedeck-ct-v2",
    productId: 0x0007,
    vendorId: 0x2ec2,
    DeviceClass: LoupedeckCTv2,
  },
  {
    model: "razer-stream-controller",
    productId: 0x0d06,
    vendorId: 0x1532,
    DeviceClass: RazerStreamController,
  },
  {
    model: "razer-stream-controller-x",
    productId: 0x0d09,
    vendorId: 0x1532,
    DeviceClass: RazerStreamControllerX,
  },
];

export function listDevices(
  options: ListOptions = {},
): Promise<DeviceDescriptor[]> {
  return listSupportedDevices(nodeTransportProvider, definitions, options);
}

export function createDevice(
  descriptor: DeviceDescriptor,
  options: LoupedeckDeviceOptions = {},
): SupportedDevice {
  return createFromDescriptor(descriptor, definitions, options);
}

/** Discover a supported device without opening it. */
export function discover(
  options: DiscoverOptions = {},
): Promise<SupportedDevice> {
  return discoverDevice(nodeTransportProvider, definitions, options);
}

/** Discover and fully connect a supported device, or reject. */
export function openDevice(
  options: DiscoverOptions = {},
): Promise<SupportedDevice> {
  return openDiscoveredDevice(nodeTransportProvider, definitions, options);
}

export type { DiscoveredConnection } from "./device.js";
export { LoupedeckDevice } from "./device.js";
export { renderNodeCanvas } from "./node-canvas.js";
export { LoupedeckSerialConnection, LoupedeckWSConnection };
