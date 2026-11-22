import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "loupedeck-package-test-"));
try {
  const pack = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    { encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(pack);
  const tarball = join(directory, filename);
  execFileSync(
    "npm",
    ["install", "--no-package-lock", "--no-save", "--ignore-scripts", tarball],
    { cwd: directory, stdio: "pipe" },
  );

  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    join(directory, "smoke.mjs"),
    `
      import { LoupedeckLive, discover, openDevice } from "loupedeck-ts-sdk";
      import { LoupedeckLive as BrowserLive, requestDevice } from "loupedeck-ts-sdk/browser";
      import { LoupedeckSerialConnection } from "loupedeck-ts-sdk/node";
      import { MagicByteLengthDecoder, COMMANDS } from "loupedeck-ts-sdk/protocol";
      if (!LoupedeckLive || !BrowserLive || !LoupedeckSerialConnection || !MagicByteLengthDecoder) throw new Error("Missing exports");
      if (!discover || !openDevice || !requestDevice || !COMMANDS.FRAMEBUFF) throw new Error("Missing functions");
      const device = new LoupedeckLive();
      if (device.state !== "disconnected") throw new Error("Construction performed I/O");
      await device.close();
    `,
  );
  execFileSync(process.execPath, [join(directory, "smoke.mjs")], {
    cwd: directory,
    stdio: "inherit",
  });

  writeFileSync(
    join(directory, "consumer.ts"),
    `
      import { LoupedeckLive, type DeviceDescriptor } from "loupedeck-ts-sdk";
      import { LoupedeckLiveS } from "loupedeck-ts-sdk/browser";
      import { MagicByteLengthDecoder } from "loupedeck-ts-sdk/protocol";
      const live = new LoupedeckLive();
      live.drawScreen("center", new Uint8Array(360 * 270 * 2));
      // @ts-expect-error
      live.drawScreen("knob", new Uint8Array());
      const browser = new LoupedeckLiveS();
      browser.drawKey(0, new Uint8Array(90 * 90 * 2));
      declare const descriptor: DeviceDescriptor;
      declare const decoder: MagicByteLengthDecoder;
      void descriptor;
      void decoder;
    `,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    }),
  );
  const require = createRequire(import.meta.url);
  const tsc = join(dirname(require.resolve("typescript")), "..", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "."], {
    cwd: directory,
    stdio: "inherit",
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
