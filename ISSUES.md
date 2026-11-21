# Known issues and follow-ups

This list comes from the static type audit of the implementation, tests, examples, documentation, and package metadata. Items that require an API-compatibility decision are marked as such.

## Runtime and protocol

- [ ] **Define or remove the missing tick command.** `device.js` registers a handler for `COMMANDS.TICK`, but `constants.js` does not define `TICK`. Add the correct protocol value if ticks are supported, or remove the handler. The tests currently named as tick tests send a button-press command instead, so they do not verify tick handling.

- [ ] **Reject connection failures with `Error` objects consistently.** `discover()` throws an `Error` when no device is found, but the manual `LoupedeckDevice.connect()` path can reject with the string returned by `onDisconnect()`. Preserve a consistent `Error`-based rejection contract.

- [ ] **Settle and clean up pending transactions.** `onReceive()` resolves pending commands without deleting their resolvers, and disconnects do not reject or otherwise settle outstanding promises. Remove completed resolvers and define disconnect/timeout behavior so commands cannot remain pending indefinitely or accumulate stale entries.

- [ ] **Normalize disconnected command behavior or document it.** `send()`, `refresh()`, `setBrightness()`, `setButtonColor()`, and `vibrate()` return `undefined` when disconnected instead of returning a rejected promise. Decide whether to preserve and document this behavior or make these methods consistently asynchronous and reject with an Error. This is an API-compatibility decision.

- [ ] **Normalize `close()` behavior.** `LoupedeckDevice.close()` can return `undefined`; serial and WebSocket close promises resolve with incidental callback values; Web Serial close resolves with `void`. Prefer a consistent `Promise<void>` contract and define whether closing an unopened device is a no-op. This is an API-compatibility decision.

- [ ] **Make callback drawing errors consistently asynchronous.** `drawBuffer()` reports failures through promise rejection, while `drawCanvas()`, `drawKey()`, and `drawScreen()` can throw synchronously before returning a promise. Consider making the public drawing methods consistently reject, or explicitly document the difference.

- [ ] **Handle WebSocket connection errors.** `LoupedeckWSConnection.connect()` has no rejection path or socket `error` listener, so failed connections can leave its promise pending. Add error handling and cleanup for failed connection attempts.

- [ ] **Correct WebSocket host discovery matching.** `connections/ws.js` uses `/.2$/`, where the dot is unescaped. Use `/\.2$/` if the intent is specifically to replace a final `.2`, and add coverage for matching and non-matching addresses.

- [ ] **Normalize disconnect reasons.** Serial emits `Error | undefined`, WebSocket emits `Error | null`, and Web Serial can emit a browser `Event`. `LoupedeckDevice.onDisconnect()` nevertheless treats truthy reasons as error-like and reads `.message`. Define one public disconnect reason shape and adapt transport events at the boundary.

- [ ] **Make Web Serial readiness boolean.** `LoupedeckWebSerialConnection.isReady()` currently returns `this.port.readable` or a falsy value rather than a boolean. Return an explicit boolean to match the other transports and the common connection contract.

- [ ] **Guard Web Serial lifecycle operations.** The Web Serial constructor immediately requires a valid `port`, and `close()`, `read()`, and `send()` assume connection-created fields are initialized. Add safe state checks, especially for closing before a successful connection, and handle nullable `port.readable`/`port.writable` values.

- [ ] **Await or deliberately handle Web Serial writes and reads.** The framed prefix write is fire-and-forget, the initial handshake write is not awaited, the background `read()` promise is not observed, and `writer.close()` is not awaited. Ensure failures are observed and operation ordering is guaranteed.

- [ ] **Normalize WebSocket message data before device parsing.** The `ws` package types incoming data as `RawData`, while `LoupedeckDevice.onReceive()` assumes Buffer methods and numeric indexing. Explicitly convert or reject unsupported `ArrayBuffer`/buffer-array forms instead of relying on current defaults.

- [ ] **Validate or intentionally accept device-inappropriate button IDs.** `setButtonColor()` performs a global reverse lookup in `BUTTONS` and does not check the current device's capabilities. It therefore accepts knob IDs and buttons absent from a device's metadata. Decide whether this is supported low-level behavior or validate against the concrete device.

- [ ] **Complete CT knob metadata.** `LoupedeckCT` can emit rotations for `knobCT`, but its inherited `knobs` array only contains the six Live knobs. Add `knobCT` if `knobs` is intended to enumerate every usable control.

- [ ] **Decide whether CT v2 needs a distinct `type`.** `LoupedeckCTv2` inherits `type = 'Loupedeck CT'`. Keep this intentionally or introduce a distinct display name; update examples and documentation to match the decision.

## Documentation and API consistency

- [ ] **Document `discover(options)` and its connection semantics.** The function accepts device constructor options and can return `LoupedeckCTv2`, but the README omits both. It also returns after constructing the device without awaiting connection establishment; replace wording that implies the returned device is already connected.

- [ ] **Correct documented method return types.** The README unconditionally describes `close()`, brightness, color, vibration, and drawing commands as promises. Document disconnected behavior and synchronous error behavior, or update the runtime contract first and then revise the documentation.

- [ ] **Correct button ID documentation.** `setButtonColor()` documents `id` as a string even though numeric IDs are standard. The Live S range is documented as 0–4 while its metadata advertises 0–3. Reconcile these with the runtime capability decision above.

- [ ] **Correct CT screen capability notes.** README method notes say left/right screens are only available on Live/RSC, while CT and CT v2 implement and test both screens.

- [ ] **Document all touch-target shapes.** Include Razer Stream Controller X's key-only target and the empty target possible for out-of-range Live S touches. Clarify that rotation deltas are signed bytes at runtime even though normal device input is generally `-1` or `1`.

- [ ] **Document actual disconnect payloads.** The README currently promises only `Error | undefined`; align it with the normalized transport contract.

- [ ] **Complete the constructor synopsis.** Add `reconnectInterval` and the `port` distinction for browser Web Serial, and clarify that `host`, `path`, and `port` are mutually exclusive selection mechanisms.

- [ ] **Fix stale README references and examples.** Update the `HAPTIC` source link and the simple example's incorrect “top right knob” comment for `knobCL`.

- [ ] **Align Node.js requirements.** The README says Node 24+, `package.json` says Node 20+, the web example says Node 20+, and CI tests multiple versions. Choose one supported range that also satisfies locked dependency requirements.

- [ ] **Clarify ESM and top-level-await compatibility.** Document that the package is ESM-only and cannot be synchronously loaded through CommonJS `require()` because its module graph uses top-level await. Asynchronous `import()` is the appropriate CommonJS migration path.

## Browser support

- [ ] **Remove the implicit global `Buffer` requirement.** `connections/web-serial.js` uses `Buffer` without importing it, requiring consumers to install and assign a browser polyfill globally. Import from `buffer` explicitly or replace Buffer usage with browser byte-array operations.

- [ ] **Make environment selection standard and predictable.** `device.js` relies on Vite-specific `import.meta.env` in addition to `navigator.serial`. Use explicit browser entry points/conditional exports or standard feature detection so native browser and non-Vite builds select the intended transports.

- [ ] **Handle CT v2 in the web example.** Add `LoupedeckCTv2` to the example's device mapping and ensure CT v2 receives the same knob UI treatment as CT rather than checking only the constructor name `LoupedeckCT`.

- [ ] **Refresh stale web-example lock metadata.** The linked local package metadata still records an older Loupedeck version. Regenerate it after the next dependency update and verify a production browser build.

## Tests and fixtures

- [ ] **Add Web Serial tests and mocks.** Cover construction, discovery, handshake, framing, readiness, writes, read errors, native disconnects, and closing before/after connection.

- [ ] **Add discovery coverage for every supported class.** In particular, test CT v2, CT, Razer Stream Controller, and Razer Stream Controller X product-ID mapping.

- [ ] **Correct stale test options.** Replace the unsupported `ip` constructor property in device tests with `host`, or remove it where auto-connect is disabled.

- [ ] **Make transport mocks match real dependencies.** Serial mocks should preserve asynchronous discovery, close callbacks, open state, and piping behavior. WebSocket mocks should model `readyState`, `OPEN`, close arguments, and errors rather than relying on `undefined === undefined` for readiness.

- [ ] **Add integration-style parser/transport coverage.** The current serial mock's no-op `pipe()` means parsed serial messages are not exercised through the real parser pipeline.

- [ ] **Expand edge-case coverage.** Add tests for disconnected command settlement, pending transactions on disconnect, unknown packet IDs, malformed short packets, RSC X key-up/touch-end symmetry, and WebSocket connection failures.

- [ ] **Add package surface tests.** Assert root exports and `HAPTIC` values, and verify the published package contains every intended runtime and declaration file.

## Type declarations and publishing

- [x] **Add declarations for the complete packaged surface.** Cover the root entry point, device classes, discovery, constants, parser, utility, and all three deep-importable connection modules.

- [x] **Add compile-only declaration tests.** Test typed emitter methods, drawing overloads, discovery-result narrowing, constructor/list options, literal constants, conditional return types, and Node/browser compilation contexts.

- [x] **Add TypeScript tooling and ambient dependencies.** Configure TypeScript plus the necessary Node, `ws`, and Web Serial declarations. Preserve the actual `canvas` context type and `strict-event-emitter` generic event maps.

- [x] **Publish and resolve declarations correctly.** Add the package `types` entry, include all `.d.ts` files in the npm package, and test both root and deep imports from a consumer-style fixture.
