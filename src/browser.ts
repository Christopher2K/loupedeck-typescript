import { renderBrowserCanvas } from "./browser-canvas.js";
import LoupedeckWebSerialConnection from "./connections/web-serial.js";
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

export const browserTransportProvider: TransportProvider = {
  async discover({
    signal,
  }: ListOptions = {}): Promise<DiscoveredConnection[]> {
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    const devices = await LoupedeckWebSerialConnection.discover();
    if (signal?.aborted) {
      throw new OperationAbortedError(undefined, { cause: signal.reason });
    }
    return devices;
  },
  create(selector: TransportSelector) {
    if (selector.port)
      return new LoupedeckWebSerialConnection({ port: selector.port });
    throw new NotConnectedError("An authorized Web Serial port is required");
  },
  open(descriptor: DiscoveredConnection) {
    if (descriptor.kind !== "web-serial") {
      throw new NotConnectedError(
        "The browser entry point supports only Web Serial",
      );
    }
    return new LoupedeckWebSerialConnection({ port: descriptor.port });
  },
};

function browserOptions(
  options: LoupedeckDeviceOptions,
): LoupedeckDeviceOptions {
  return {
    ...options,
    transportProvider: options.transportProvider ?? browserTransportProvider,
    canvasRenderer: options.canvasRenderer ?? renderBrowserCanvas,
  };
}

export class LoupedeckLive extends CoreLoupedeckLive {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
  }
}

export class LoupedeckLiveS extends CoreLoupedeckLiveS {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
  }
}

export class LoupedeckCT extends CoreLoupedeckCT {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
  }
}

export class LoupedeckCTv2 extends CoreLoupedeckCTv2 {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
  }
}

export class RazerStreamController extends CoreRazerStreamController {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
  }
}

export class RazerStreamControllerX extends CoreRazerStreamControllerX {
  constructor(options: LoupedeckDeviceOptions = {}) {
    super(browserOptions(options));
  }
  static override list(
    options: ListOptions = {},
  ): Promise<DiscoveredConnection[]> {
    return browserTransportProvider.discover(options);
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
  return listSupportedDevices(browserTransportProvider, definitions, options);
}

export function createDevice(
  descriptor: DeviceDescriptor,
  options: LoupedeckDeviceOptions = {},
): SupportedDevice {
  return createFromDescriptor(descriptor, definitions, options);
}

export function discover(
  options: DiscoverOptions = {},
): Promise<SupportedDevice> {
  return discoverDevice(browserTransportProvider, definitions, options);
}

export function openDevice(
  options: DiscoverOptions = {},
): Promise<SupportedDevice> {
  return openDiscoveredDevice(browserTransportProvider, definitions, options);
}

/** Request browser permission from a user-activation handler, then create a device. */
export async function requestDevice(
  options: LoupedeckDeviceOptions = {},
): Promise<SupportedDevice> {
  const descriptor = await LoupedeckWebSerialConnection.request();
  const definition = definitions.find(
    (candidate) =>
      candidate.vendorId === descriptor.vendorId &&
      candidate.productId === descriptor.productId,
  );
  if (!definition) {
    throw new NotConnectedError(
      `Unsupported device ${descriptor.vendorId}:${descriptor.productId}`,
    );
  }
  return new definition.DeviceClass({ ...options, descriptor });
}

export { renderBrowserCanvas } from "./browser-canvas.js";
export type { DiscoveredConnection } from "./device.js";
export { LoupedeckDevice } from "./device.js";
export { LoupedeckWebSerialConnection };
