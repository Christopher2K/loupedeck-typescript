import { NotConnectedError } from "./errors.js";
import type { DiscoveredConnection, TransportProvider } from "./transport.js";
import type {
  DeviceDescriptor,
  DeviceModel,
  DiscoverOptions,
  ListOptions,
  LoupedeckDeviceOptions,
} from "./types.js";

export interface DeviceDefinition<T> {
  model: DeviceModel;
  productId: number;
  vendorId: number;
  DeviceClass: new (options?: LoupedeckDeviceOptions) => T;
}

export async function listSupportedDevices<T>(
  provider: TransportProvider,
  definitions: readonly DeviceDefinition<T>[],
  options: ListOptions = {},
): Promise<DeviceDescriptor[]> {
  const discovered = await provider.discover(options);
  const devices: DeviceDescriptor[] = [];
  for (const descriptor of discovered) {
    const definition = definitions.find(
      (candidate) =>
        candidate.vendorId === descriptor.vendorId &&
        candidate.productId === descriptor.productId,
    );
    if (definition) devices.push({ ...descriptor, model: definition.model });
  }
  return devices;
}

export function createFromDescriptor<T>(
  descriptor: DeviceDescriptor,
  definitions: readonly DeviceDefinition<T>[],
  options: LoupedeckDeviceOptions = {},
): T {
  const definition = definitions.find(
    (candidate) =>
      candidate.model === descriptor.model &&
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

export async function discoverDevice<T>(
  provider: TransportProvider,
  definitions: readonly DeviceDefinition<T>[],
  options: DiscoverOptions = {},
): Promise<T> {
  const devices = await listSupportedDevices(provider, definitions, options);
  const descriptor = devices.find(
    (candidate) =>
      (options.serialNumber === undefined ||
        candidate.serialNumber === options.serialNumber) &&
      (options.model === undefined || candidate.model === options.model) &&
      (options.transport === undefined || candidate.kind === options.transport),
  );
  if (!descriptor) {
    throw new NotConnectedError(
      devices.length ? "No matching devices found" : "No devices found",
    );
  }
  return createFromDescriptor(descriptor, definitions, options);
}

export async function openDiscoveredDevice<
  T extends { connect(): Promise<void> },
>(
  provider: TransportProvider,
  definitions: readonly DeviceDefinition<T>[],
  options: DiscoverOptions = {},
): Promise<T> {
  const device = await discoverDevice(provider, definitions, options);
  try {
    await device.connect();
    return device;
  } catch (error) {
    if ("close" in device && typeof device.close === "function") {
      await device.close().catch(() => {});
    }
    throw error;
  }
}

export function descriptorId(descriptor: DiscoveredConnection): string {
  switch (descriptor.kind) {
    case "node-serial":
      return `${descriptor.kind}:${descriptor.path}`;
    case "websocket":
      return `${descriptor.kind}:${descriptor.host}`;
    case "web-serial":
      return `${descriptor.kind}:${descriptor.vendorId}:${descriptor.productId}:${descriptor.serialNumber ?? "unknown"}`;
  }
}
