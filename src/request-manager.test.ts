import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CommandTimeoutError,
  DisconnectedError,
  OperationAbortedError,
  ProtocolError,
  TooManyPendingRequestsError,
} from "./errors.js";
import { RequestManager } from "./request-manager.js";

const defaults = {
  command: 0x10,
  generation: 1,
  timeoutMs: 1000,
};

describe("RequestManager", () => {
  it("registers a request before writing", async () => {
    const manager = new RequestManager();
    const request = manager.request({
      ...defaults,
      write: (id) => {
        manager.resolve(id, 0x10, "written");
      },
    });
    assert.equal(await request, "written");
  });

  it("rejects mismatched response commands", async () => {
    const manager = new RequestManager();
    const request = manager.request({
      ...defaults,
      write: (id) => {
        manager.resolve(id, 0x0f, undefined);
      },
    });
    await assert.rejects(request, ProtocolError);
  });

  it("times out requests", async () => {
    const manager = new RequestManager();
    const request = manager.request({
      ...defaults,
      timeoutMs: 5,
      write: () => {},
    });
    await assert.rejects(request, CommandTimeoutError);
  });

  it("rejects pending requests on disconnect", async () => {
    const manager = new RequestManager();
    const request = manager.request({ ...defaults, write: () => {} });
    manager.rejectAll(new DisconnectedError(), 1);
    await assert.rejects(request, DisconnectedError);
  });

  it("cancels requests with an AbortSignal", async () => {
    const manager = new RequestManager();
    const controller = new AbortController();
    const request = manager.request({
      ...defaults,
      signal: controller.signal,
      write: () => {},
    });
    controller.abort();
    await assert.rejects(request, OperationAbortedError);
  });

  it("propagates synchronous and asynchronous write failures", async () => {
    const manager = new RequestManager();
    await assert.rejects(
      manager.request({
        ...defaults,
        write: () => {
          throw new Error("sync write");
        },
      }),
      /sync write/,
    );
    await assert.rejects(
      manager.request({
        ...defaults,
        write: () => Promise.reject(new Error("async write")),
      }),
      /async write/,
    );
  });

  it("does not reuse live transaction IDs", async () => {
    const manager = new RequestManager();
    const requests: Promise<unknown>[] = [];
    const ids: number[] = [];
    for (let index = 0; index < 255; index++) {
      requests.push(
        manager.request({
          ...defaults,
          write: (id) => {
            ids.push(id);
          },
        }),
      );
    }
    assert.equal(new Set(ids).size, 255);
    assert(!ids.includes(0));
    assert.throws(
      () => manager.request({ ...defaults, write: () => {} }),
      TooManyPendingRequestsError,
    );
    manager.rejectAll(new DisconnectedError());
    await Promise.allSettled(requests);
  });
});
