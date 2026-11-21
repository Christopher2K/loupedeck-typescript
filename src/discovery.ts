import type {
  LoupedeckCT,
  LoupedeckCTv2,
  LoupedeckLive,
  LoupedeckLiveS,
  RazerStreamController,
  RazerStreamControllerX,
} from "./device.js";
import * as ALL_DEVICES from "./device.js";
import type { LoupedeckDeviceOptions } from "./types.js";

export type SupportedDevice =
  | LoupedeckLive
  | LoupedeckLiveS
  | LoupedeckCT
  | LoupedeckCTv2
  | RazerStreamController
  | RazerStreamControllerX;

interface SupportedDeviceConstructor {
  new (options?: LoupedeckDeviceOptions): SupportedDevice;
  productId: number;
}

/**
 * Finds the first available supported device and creates an instance for it.
 *
 * Serial and WebSocket connections are discovered in parallel. By default, the
 * returned device starts connecting immediately; pass `autoConnect: false` to
 * connect explicitly with the device's `connect()` method.
 *
 * @param args - Device construction and connection options. Discovered
 * connection details take precedence over conflicting values in `args`.
 * @returns A device instance for the first discovered connection.
 * @throws If no devices are found or the discovered product is unsupported.
 */
export async function discover(
  args?: LoupedeckDeviceOptions,
): Promise<SupportedDevice> {
  const devices = await ALL_DEVICES.LoupedeckDevice.list();
  if (devices.length === 0) throw new Error("No devices found");
  const { productId, ...connectArgs } = devices[0];
  const deviceType = (
    Object.values(ALL_DEVICES) as SupportedDeviceConstructor[]
  ).find((dev) => dev.productId === productId);
  if (!deviceType)
    throw new Error(
      `Device with product ID ${productId} not yet supported! Please file an issue at https://github.com/foxxyz/loupedeck/issues`,
    );
  const device = new deviceType({ ...args, ...connectArgs });
  return device;
}
