import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { SerialPort } from "serialport";
import {
  discover,
  LoupedeckCT,
  LoupedeckCTv2,
  LoupedeckLive,
  LoupedeckLiveS,
  listDevices,
  RazerStreamController,
  RazerStreamControllerX,
} from "./index.js";

describe("Device Discovery", () => {
  it("reports if no devices found", async () => {
    const spy = mock.method(SerialPort, "list", async () => [
      {
        path: "/dev/cu.usbmodem-222",
        manufacturer: "Apple",
        serialNumber: "G4429927",
        locationId: "14100001",
        vendorId: "8aaa",
        productId: "52b5",
      },
    ]);
    await assert.rejects(discover(), /no devices found/i);
    spy.mock.restore();
  });
  it("can auto-discover a Loupedeck Live device", async () => {
    const spy = mock.method(SerialPort, "list", async () => [
      {
        path: "/dev/cu.usbmodem-333",
        manufacturer: "Loupedeck",
        serialNumber: "LDD12345678",
        locationId: "14100002",
        vendorId: "2ec2",
        productId: "0004",
      },
    ]);
    const device = await discover({ autoConnect: false });
    assert(device instanceof LoupedeckLive);
    spy.mock.restore();
  });
  it("can auto-discover a Loupedeck Live S device", async () => {
    const spy = mock.method(SerialPort, "list", async () => [
      {
        path: "/dev/cu.usbmodem-444",
        manufacturer: "Loupedeck",
        serialNumber: "LDD12345678",
        locationId: "14100000",
        vendorId: "2ec2",
        productId: "0006",
      },
    ]);
    const device = await discover({ autoConnect: false });
    assert(device instanceof LoupedeckLiveS);
    spy.mock.restore();
  });
  it("maps every supported vendor/product pair", async () => {
    const cases = [
      ["0003", LoupedeckCT],
      ["0007", LoupedeckCTv2],
      ["0d06", RazerStreamController],
      ["0d09", RazerStreamControllerX],
    ] as const;
    for (const [productId, DeviceClass] of cases) {
      const spy = mock.method(SerialPort, "list", async () => [
        {
          path: "/dev/test",
          manufacturer: "Loupedeck",
          serialNumber: "test",
          vendorId: productId.startsWith("0d") ? "1532" : "2ec2",
          productId,
        },
      ]);
      const device = await discover();
      assert(device instanceof DeviceClass);
      assert.equal(device.state, "disconnected");
      spy.mock.restore();
    }
  });
  it("skips unsupported devices and supports selectors", async () => {
    const spy = mock.method(SerialPort, "list", async () => [
      {
        path: "/dev/unsupported",
        manufacturer: "Loupedeck",
        serialNumber: "unknown",
        vendorId: "2ec2",
        productId: "000d",
      },
      {
        path: "/dev/live-s",
        manufacturer: "Loupedeck",
        serialNumber: "wanted",
        vendorId: "2ec2",
        productId: "0006",
      },
      {
        path: "/dev/live",
        manufacturer: "Loupedeck",
        serialNumber: "other",
        vendorId: "2ec2",
        productId: "0004",
      },
    ]);
    const descriptors = await listDevices();
    assert.deepEqual(
      descriptors.map((device) => device.model),
      ["loupedeck-live-s", "loupedeck-live"],
    );
    const device = await discover({
      model: "loupedeck-live-s",
      serialNumber: "wanted",
      transport: "node-serial",
    });
    assert(device instanceof LoupedeckLiveS);
    spy.mock.restore();
  });
  it("ignores unknown devices", async () => {
    const spy = mock.method(SerialPort, "list", async () => [
      {
        path: "/dev/cu.usbmodem-444",
        manufacturer: "Loupedeck",
        serialNumber: "LDD12345678",
        locationId: "14100000",
        vendorId: "2ec2",
        productId: "000d",
      },
    ]);
    await assert.rejects(discover(), /no devices found/i);
    spy.mock.restore();
  });
});
