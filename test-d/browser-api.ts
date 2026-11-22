import type { SupportedDevice } from "loupedeck-ts-sdk/browser";
import {
  LoupedeckLiveS,
  LoupedeckWebSerialConnection,
  listDevices,
  requestDevice,
} from "loupedeck-ts-sdk/browser";

function expectType<T>(value: T): T {
  return value;
}

const device = new LoupedeckLiveS();
expectType<Promise<void>>(device.drawKey(0, new Uint8Array(90 * 90 * 2)));
// @ts-expect-error Live S has only the center display.
device.drawScreen("knob", new Uint8Array());
expectType<Promise<SupportedDevice>>(requestDevice());
expectType<Promise<unknown[]>>(listDevices());
declare const port: SerialPort;
expectType<LoupedeckWebSerialConnection>(
  new LoupedeckWebSerialConnection({ port }),
);
