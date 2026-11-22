import type {
  ConnectionState,
  ControlId,
  DeviceDescriptor,
  DeviceInfo,
  DrawCallback,
  HapticPattern,
  SupportedDevice,
  Touch,
} from "loupedeck-ts-sdk";
import {
  createDevice,
  DeviceClosedError,
  discover,
  HAPTIC,
  LoupedeckCT,
  LoupedeckCTv2,
  type LoupedeckDevice,
  LoupedeckLive,
  LoupedeckLiveS,
  listDevices,
  openDevice,
  RazerStreamControllerX,
} from "loupedeck-ts-sdk";
import {
  LoupedeckSerialConnection,
  LoupedeckWSConnection,
  renderNodeCanvas,
} from "loupedeck-ts-sdk/node";
import {
  COMMANDS,
  MAX_BRIGHTNESS,
  MagicByteLengthDecoder,
  rgba2rgb565,
} from "loupedeck-ts-sdk/protocol";

function expectType<T>(value: T): T {
  return value;
}

const live = new LoupedeckLive({ reconnectInterval: false });
expectType<number>(live.capabilities.keySize);
expectType<ConnectionState>(live.state);
expectType<DeviceClosedError>(new DeviceClosedError());

live.on("down", ({ id }) => {
  expectType<ControlId>(id);
});
live.on("rotate", ({ id, delta }) => {
  expectType<ControlId>(id);
  expectType<number>(delta);
});
live.on("touchstart", ({ changedTouches, touches }) => {
  expectType<Touch>(changedTouches[0]!);
  expectType<Touch[]>(touches);
  expectType<"key" | "screen" | "none">(changedTouches[0]!.target.kind);
});
live.once("connect", ({ address }) => {
  expectType<string | undefined>(address);
});
// @ts-expect-error Unknown events are rejected.
live.on("unknown", () => {});
// @ts-expect-error Transport internals are private.
live.connection;
// @ts-expect-error Raw commands are not part of the high-level device API.
live.send;

const drawCallback: DrawCallback = (context, width, height) => {
  expectType<number>(width);
  expectType<number>(height);
  context.fillRect(0, 0, width, height);
};
expectType<Promise<void>>(live.drawKey(0, new Uint8Array(90 * 90 * 2)));
expectType<Promise<void>>(live.drawKey(0, drawCallback));
expectType<Promise<void>>(
  live.drawScreen("center", new Uint8Array(360 * 270 * 2)),
);
expectType<Promise<void>>(live.drawScreen("center", drawCallback));
// @ts-expect-error Live devices do not have a knob display.
live.drawScreen("knob", new Uint8Array(0));
const liveS = new LoupedeckLiveS();
// @ts-expect-error Live S has only the center display.
liveS.drawScreen("left", new Uint8Array(0));
const ct = new LoupedeckCT();
expectType<Promise<void>>(ct.drawScreen("knob", new Uint8Array(240 * 240 * 2)));

expectType<Promise<DeviceInfo>>(live.getInfo());
expectType<Promise<void>>(live.setBrightness(1));
expectType<Promise<void>>(live.setButtonColor({ id: 0, color: "red" }));
expectType<Promise<void>>(live.vibrate(HAPTIC.SHORT));
expectType<Promise<void>>(live.close());
expectType<Promise<void>>(live.connect());

const discovered = discover({ model: "loupedeck-live" });
expectType<Promise<SupportedDevice>>(discovered);
expectType<Promise<DeviceDescriptor[]>>(listDevices());
expectType<Promise<SupportedDevice>>(openDevice());
async function narrowDevice(): Promise<void> {
  const device = await discovered;
  if (device instanceof LoupedeckCTv2) expectType<LoupedeckCTv2>(device);
  if (device instanceof LoupedeckLiveS) expectType<LoupedeckLiveS>(device);
  if (device instanceof RazerStreamControllerX) {
    expectType<LoupedeckDevice>(device);
  }
}
void narrowDevice();

declare const descriptor: DeviceDescriptor;
expectType<SupportedDevice>(createDevice(descriptor));
expectType<1>(HAPTIC.SHORT);
expectType<0x1b>(COMMANDS.SET_VIBRATION);
expectType<10>(MAX_BRIGHTNESS);
expectType<HapticPattern>(HAPTIC.RUMBLE1);
expectType<Uint8Array>(rgba2rgb565(new Uint8ClampedArray(4)));
expectType<MagicByteLengthDecoder>(new MagicByteLengthDecoder(0x82));
expectType<LoupedeckSerialConnection>(
  new LoupedeckSerialConnection({ path: "/dev/ttyUSB0" }),
);
expectType<LoupedeckWSConnection>(
  new LoupedeckWSConnection({ host: "127.0.0.1" }),
);
expectType<typeof renderNodeCanvas>(renderNodeCanvas);
