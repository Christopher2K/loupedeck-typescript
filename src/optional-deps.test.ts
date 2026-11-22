import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import type { LoupedeckLiveS as LoupedeckLiveSClass } from "./index.js";
import { setMockConnection } from "./testing/helpers.js";

mock.module("canvas", {});
const { LoupedeckLiveS } = await import("./index.js");

let device: LoupedeckLiveSClass;
describe("Optional Dependencies", () => {
  beforeEach(() => {
    device = new LoupedeckLiveS({ autoConnect: false });
    setMockConnection(device);
  });
  it("informs the user if the canvas library is not installed", async () => {
    await assert.rejects(
      device.drawKey(6, () => {}),
      /Canvas drawing.*optional 'canvas' package/i,
    );
  });
});
