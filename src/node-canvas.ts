import { UnsupportedCapabilityError } from "./errors.js";
import type { CanvasRenderer } from "./types.js";

/** Lazily loaded renderer for the optional node-canvas integration. */
export const renderNodeCanvas: CanvasRenderer = async (
  width,
  height,
  callback,
) => {
  let canvasModule: typeof import("canvas");
  try {
    canvasModule = await import("canvas");
  } catch (_error) {
    throw new UnsupportedCapabilityError(
      "Canvas drawing; install the optional 'canvas' package",
    );
  }
  if (typeof canvasModule.createCanvas !== "function") {
    throw new UnsupportedCapabilityError(
      "Canvas drawing; install the optional 'canvas' package",
    );
  }
  const canvas = canvasModule.createCanvas(width, height);
  const context = canvas.getContext("2d", { pixelFormat: "RGB16_565" });
  callback(context as unknown as CanvasRenderingContext2D, width, height);
  return canvas.toBuffer("raw");
};
