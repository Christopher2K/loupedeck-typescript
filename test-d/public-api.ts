import type {
  ControlId,
  DeviceInfo,
  DrawCallback,
  HapticPattern,
  PacketResponse,
  ScreenId,
  SupportedDevice,
  Touch,
} from "loupedeck";
import {
  discover,
  HAPTIC,
  LoupedeckCTv2,
  LoupedeckDevice,
  LoupedeckLive,
  LoupedeckLiveS,
  RazerStreamControllerX,
} from "loupedeck";
import LoupedeckSerialConnection from "loupedeck/connections/serial.js";
import LoupedeckWebSerialConnection from "loupedeck/connections/web-serial.js";
import LoupedeckWSConnection from "loupedeck/connections/ws.js";
import { BUTTONS, COMMANDS, MAX_BRIGHTNESS } from "loupedeck/constants.js";
import { MagicByteLengthParser } from "loupedeck/parser.js";
import { rgba2rgb565 } from "loupedeck/util.js";

function expectType<T>(value: T): T {
  return value;
}

const live = new LoupedeckLive({
  autoConnect: false,
  reconnectInterval: false,
});
expectType<number>(live.keySize);
expectType<ScreenId>("center");

live.on("down", ({ id }) => {
  expectType<ControlId | undefined>(id);
});
live.on("rotate", ({ id, delta }) => {
  expectType<ControlId | undefined>(id);
  expectType<number>(delta);
});
live.on("touchstart", ({ changedTouches, touches }) => {
  expectType<Touch>(changedTouches[0]);
  expectType<Touch[]>(touches);
});
live.once("connect", ({ address }) => {
  expectType<string | undefined>(address);
});
// @ts-expect-error Unknown events are rejected.
live.on("unknown", () => {});

const drawCallback: DrawCallback = (context, width, height) => {
  expectType<number>(width);
  expectType<number>(height);
  context.fillRect(0, 0, width, height);
};
expectType<Promise<void>>(live.drawKey(0, Buffer.alloc(90 * 90 * 2)));
expectType<Promise<void>>(live.drawKey(0, drawCallback));
expectType<Promise<void>>(
  live.drawScreen("center", Buffer.alloc(360 * 270 * 2)),
);
expectType<Promise<void>>(live.drawScreen("center", drawCallback));
// @ts-expect-error Unknown displays are rejected.
live.drawScreen("invalid", Buffer.alloc(0));

expectType<Promise<DeviceInfo>>(live.getInfo());
expectType<Promise<PacketResponse> | undefined>(live.setBrightness(1));
expectType<Promise<PacketResponse> | undefined>(
  live.setButtonColor({ id: 0, color: "red" }),
);
expectType<Promise<PacketResponse> | undefined>(live.vibrate(HAPTIC.SHORT));
expectType<Promise<unknown> | undefined>(live.close());

const discovered = discover({ autoConnect: false });
expectType<Promise<SupportedDevice>>(discovered);
async function narrowDevice(): Promise<void> {
  const device = await discovered;
  if (device instanceof LoupedeckCTv2) expectType<LoupedeckCTv2>(device);
  if (device instanceof LoupedeckLiveS) expectType<LoupedeckLiveS>(device);
  if (device instanceof RazerStreamControllerX)
    expectType<LoupedeckDevice>(device);
}
void narrowDevice();

expectType<1>(HAPTIC.SHORT);
expectType<0x1b>(COMMANDS.SET_VIBRATION);
expectType<10>(MAX_BRIGHTNESS);
expectType<ControlId>(BUTTONS[0]);
const pattern: HapticPattern = HAPTIC.RUMBLE1;
expectType<HapticPattern>(pattern);

expectType<Promise<import("loupedeck").DiscoveredConnection[]>>(
  LoupedeckDevice.list(),
);
expectType<Buffer>(rgba2rgb565(new Uint8ClampedArray(4), 1));
expectType<MagicByteLengthParser>(
  new MagicByteLengthParser({ magicByte: 0x82 }),
);
expectType<LoupedeckSerialConnection>(
  new LoupedeckSerialConnection({ path: "/dev/ttyUSB0" }),
);
expectType<LoupedeckWSConnection>(
  new LoupedeckWSConnection({ host: "127.0.0.1" }),
);
declare const port: SerialPort;
expectType<LoupedeckWebSerialConnection>(
  new LoupedeckWebSerialConnection({ port }),
);
