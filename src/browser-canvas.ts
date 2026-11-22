import { UnsupportedCapabilityError } from "./errors.js";
import type { CanvasRenderer } from "./types.js";
import { rgba2rgb565 } from "./util.js";

/** Render through OffscreenCanvas or an HTML canvas in browser entry points. */
export const renderBrowserCanvas: CanvasRenderer = (
  width,
  height,
  callback,
) => {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new UnsupportedCapabilityError("Browser canvas rendering");
  }
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!context) throw new UnsupportedCapabilityError("Canvas 2D rendering");
  callback(context, width, height);
  return rgba2rgb565(
    context.getImageData(0, 0, width, height).data,
    width * height,
  );
};
