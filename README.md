# Loupedeck TypeScript SDK

Unofficial TypeScript SDK for Loupedeck Live, Live S, CT/CT v2, Razer Stream Controller, and Razer Stream Controller X.

Supports button/knob input, touch input, LEDs, brightness, haptics, and RGB565 display drawing in Node.js and browser Web Serial environments.

## Requirements

- Node.js 20.19+ for the Node entry point.
- A browser with Web Serial support and a secure context for the browser entry point.
- ESM. CommonJS consumers can use asynchronous `import()`.

Tested firmware includes 0.1.2, 0.1.3, 0.1.79, 0.2.5, 0.2.8, and 0.2.23.

> Ensure Loupedeck's desktop software is not running; it may conflict with direct device access. Firmware 0.2.26 has known Linux issues.

## Installation

```sh
npm install loupedeck-ts-sdk
```

Raw drawing accepts `Uint8Array` and has no native rendering dependency. For Node canvas callbacks, install the optional peer:

```sh
npm install canvas
```

Browser canvas callbacks use `OffscreenCanvas` or `HTMLCanvasElement` and do not need `canvas` or a global `Buffer`.

## Quick start

Construction and discovery do not perform I/O. Attach listeners before explicitly connecting:

```ts
import { discover } from "loupedeck-ts-sdk";

const device = await discover();

device.on("down", ({ id }) => {
  console.log(`Button pressed: ${id}`);
});
device.on("rotate", ({ id, delta }) => {
  console.log(`Knob ${id} rotated: ${delta}`);
});

try {
  await device.connect();
  await device.setBrightness(0.8);
} finally {
  await device.close();
}
```

Use `openDevice()` when a guaranteed-ready device is more convenient:

```ts
import { openDevice } from "loupedeck-ts-sdk";

const device = await openDevice(); // Connected or rejects; never half-open.
```

`close()` is idempotent, cancels reconnection and outstanding commands, and makes the instance terminal. Create a new instance to connect again.

## Discovery

```ts
import {
  createDevice,
  discover,
  listDevices,
  openDevice,
} from "loupedeck-ts-sdk";

const descriptors = await listDevices();
const first = createDevice(descriptors[0]!);

const liveS = await discover({
  model: "loupedeck-live-s",
  serialNumber: "LDD12345678",
  transport: "node-serial",
});

await liveS.connect();
```

Discovery matches both USB vendor and product IDs, filters unsupported devices, and supports model, serial-number, and transport selectors. A partial transport discovery failure does not hide devices found through another transport; if every transport fails, discovery throws an `AggregateError`.

For direct construction, supply exactly one connection selector:

```ts
import { LoupedeckLiveS } from "loupedeck-ts-sdk";

const serial = new LoupedeckLiveS({ path: "/dev/tty.usbmodem101" });
const legacy = new LoupedeckLiveS({ host: "127.100.1.1" });
```

Options:

- `path`: Node serial path for firmware 0.2.x.
- `host`: WebSocket host for firmware 0.1.x.
- `port`: authorized Web Serial port when using the browser entry point.
- `reconnectInterval`: delay in milliseconds, or `false` to disable reconnection. Default: `3000`.
- `commandTimeoutMs`: acknowledgement timeout. Default: `3000`.

The deprecated `autoConnect` option is ignored; constructors are always side-effect-free.

## Browser Web Serial

Enumeration is passive and never opens a permission chooser. Call `requestDevice()` from a user-activation handler:

```ts
import { requestDevice } from "loupedeck-ts-sdk/browser";

button.addEventListener("click", async () => {
  const device = await requestDevice();
  device.on("down", ({ id }) => console.log(id));
  await device.connect();
});
```

The browser entry point supports Web Serial only. Node-only serial and WebSocket modules are not included in its runtime graph.

## Device API

All commands return promises and reject when disconnected, cancelled, unsupported, or not acknowledged in time. Public asynchronous methods consistently report validation failures through rejection.

### Connection and information

```ts
await device.connect({ signal });
await device.close();
const state = device.state;
const { serial, version } = await device.getInfo({ signal });
```

`state` is `disconnected`, `connecting`, `connected`, `closing`, or `closed`.

### LEDs, brightness, and haptics

```ts
await device.setBrightness(0.5, { signal, timeoutMs: 3000 });
await device.setButtonColor({ id: 0, color: "#09f" }, { signal });
await device.vibrate(HAPTIC.SHORT, { signal });
```

`setBrightness()` accepts finite values and clamps them to `[0, 1]`. `vibrate()` accepts a `HapticPattern`. Razer Stream Controller X rejects LED and haptic operations with `UnsupportedCapabilityError`.

### Capabilities

```ts
const { model, buttons, knobs, screens, keyCount, keySize, leds, haptics } =
  device.capabilities;
```

Capability arrays are immutable snapshots. Display IDs accepted by `drawScreen()` are also narrowed by concrete device class at compile time.

### Drawing

Raw input is RGB565, two bytes per pixel, little-endian except for the CT knob display (big-endian).

```ts
await device.drawKey(0, new Uint8Array(90 * 90 * 2));
await device.drawScreen("center", pixels);
await device.drawBuffer(
  { id: "center", x: 0, y: 0, width: 90, height: 90 },
  pixels,
  { signal },
);
```

`drawKey()` and `drawScreen()` also accept a canvas callback:

```ts
await device.drawKey(0, (context, width, height) => {
  context.fillStyle = "#09f";
  context.fillRect(0, 0, width, height);
});
```

Drawing validates integer coordinates, positive dimensions, display bounds, key indices, and exact buffer length. `autoRefresh: false` is available through `drawBuffer()`/`drawCanvas()` when batching framebuffer updates.

### Events

- `connect`: `{ address }`
- `disconnect`: `Error | undefined`
- `down` / `up`: `{ id }`
- `rotate`: `{ id, delta }`
- `touchstart` / `touchmove` / `touchend`: `{ touches, changedTouches }`
- `unknownControl`: raw numeric control information not present in the known map
- `protocolError`: malformed incoming data

Touch targets are discriminated by `kind`:

```ts
if (touch.target.kind === "key") {
  console.log(touch.target.key);
} else if (touch.target.kind === "screen") {
  console.log(touch.target.screen);
}
```

Transient touch state is cleared on disconnect. Razer X key contacts use stable per-key synthetic touch IDs.

## Entry points

- `loupedeck-ts-sdk`: default Node SDK.
- `loupedeck-ts-sdk/node`: explicit Node transports and canvas renderer.
- `loupedeck-ts-sdk/browser`: Web Serial and browser canvas renderer.
- `loupedeck-ts-sdk/protocol`: advanced protocol constants, portable frame decoder, and RGB conversion.
- `loupedeck-ts-sdk/node-canvas`: lazy optional Node canvas adapter.

The high-level API intentionally does not expose connection objects, transaction tables, or raw command handlers. Custom platform integrations can use the exported `TransportProvider` and `DeviceTransport` contracts.

## Errors

SDK errors derive from `LoupedeckError`: `NotConnectedError`, `DeviceClosedError`, `ConnectionTimeoutError`, `CommandTimeoutError`, `DisconnectedError`, `OperationAbortedError`, `UnsupportedCapabilityError`, `ProtocolError`, `InvalidArgumentError`, and `TooManyPendingRequestsError`.

## Development

```sh
npm ci
npm run lint
npm run test:types
npm run test:package
npm test
```

## License

MIT
