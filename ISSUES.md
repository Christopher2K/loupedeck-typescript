# Known issues and follow-ups

The TypeScript SDK redesign now covers explicit connection lifecycle, request settlement/timeouts, typed errors, capability metadata, data-oriented discovery, platform entry points, portable bytes/framing, optional rendering adapters, Web Serial tests, and packed-package checks.

## Remaining validation and design work

- [ ] **Exercise the redesigned transports with physical devices.** Cover every supported model and both firmware families, especially fragmented/coalesced serial handshakes, acknowledgement matching, close/reconnect, and high-frequency drawing.
- [ ] **Verify Web Serial in supported browsers.** The mock stream suite covers lifecycle and framing, and the Vite production build passes, but browser/device behavior still needs an integration run.
- [ ] **Document exact firmware support by model.** Confirm the short timestamp-shaped packets currently ignored by the button decoder and remove that compatibility behavior only if a real tick command is identified.
- [ ] **Reduce duplicated model tests.** Extract common protocol/device conformance suites while retaining small model-specific display and input fixtures.
- [ ] **Add transport fault-injection tests with real backends.** Current tests cover refused/invalid handshakes and mocked stream errors; add serial disconnect, OS permission failure, and WebSocket abnormal-close integration fixtures where practical.
- [ ] **Consider backoff and retry limits.** Reconnection currently uses a fixed configurable interval. Add exponential backoff/jitter only if real-world usage demonstrates a need.
- [ ] **Evaluate an explicit raw-command API.** The high-level device surface intentionally hides transactions and raw handlers. The protocol entry point exposes constants/codecs, but sending arbitrary commands would require a separately designed advanced session API.
- [ ] **Track example dependency advisories separately.** The web example's development dependency tree currently reports audit findings; review updates without conflating them with SDK runtime issues.

## Intentional breaking contracts

- Constructors and `discover()` never open a connection. Use `connect()` or `openDevice()`.
- Commands reject while disconnected and return `Promise<void>` for acknowledged setters/drawing.
- `close()` always returns `Promise<void>`, cancels outstanding work, and is terminal.
- Public pixel data uses `Uint8Array`; Node `Buffer` remains compatible as a subtype.
- Browser permission requests are explicit through `requestDevice()`.
- Node, browser, protocol, and rendering APIs have explicit package entry points rather than wildcard deep imports.
