import {
  asError,
  CommandTimeoutError,
  OperationAbortedError,
  ProtocolError,
  TooManyPendingRequestsError,
} from "./errors.js";
import type { PacketResponse } from "./types.js";

interface PendingRequest {
  command: number;
  generation: number;
  resolve: (response: PacketResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortCleanup: (() => void) | undefined;
}

interface RequestOptions {
  command: number;
  generation: number;
  timeoutMs: number;
  signal?: AbortSignal;
  write: (transactionId: number) => void | Promise<void>;
}

/** Tracks command acknowledgements for one device session. */
export class RequestManager {
  private readonly pending = new Map<number, PendingRequest>();
  private transactionId = 0;

  request({
    command,
    generation,
    timeoutMs,
    signal,
    write,
  }: RequestOptions): Promise<PacketResponse> {
    if (signal?.aborted) {
      return Promise.reject(
        new OperationAbortedError(undefined, { cause: signal.reason }),
      );
    }

    const transactionId = this.allocateTransactionId();
    return new Promise<PacketResponse>((resolve, reject) => {
      const request: PendingRequest = {
        command,
        generation,
        resolve,
        reject,
        timeout: undefined,
        abortCleanup: undefined,
      };

      const abort = () => {
        this.settle(
          transactionId,
          new OperationAbortedError(undefined, { cause: signal?.reason }),
        );
      };
      request.timeout = setTimeout(() => {
        this.settle(transactionId, new CommandTimeoutError(transactionId));
      }, timeoutMs);
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        request.abortCleanup = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(transactionId, request);

      try {
        Promise.resolve(write(transactionId)).catch((error: unknown) => {
          this.settle(transactionId, asError(error, "Command write failed"));
        });
      } catch (error) {
        this.settle(transactionId, asError(error, "Command write failed"));
      }
    });
  }

  resolve(
    transactionId: number,
    command: number,
    response: PacketResponse,
  ): boolean {
    const request = this.pending.get(transactionId);
    if (!request) return false;
    if (request.command !== command) {
      this.settle(
        transactionId,
        new ProtocolError(
          `Response command 0x${command.toString(16)} does not match request command 0x${request.command.toString(16)}`,
        ),
      );
      return false;
    }
    this.settle(transactionId, undefined, response);
    return true;
  }

  reject(transactionId: number, error: Error): void {
    this.settle(transactionId, error);
  }

  rejectAll(error: Error, generation?: number): void {
    for (const [transactionId, request] of this.pending) {
      if (generation === undefined || request.generation === generation) {
        this.settle(transactionId, error);
      }
    }
  }

  private allocateTransactionId(): number {
    for (let attempts = 0; attempts < 255; attempts++) {
      this.transactionId = (this.transactionId + 1) % 256;
      if (this.transactionId === 0) this.transactionId = 1;
      if (!this.pending.has(this.transactionId)) return this.transactionId;
    }
    throw new TooManyPendingRequestsError();
  }

  private settle(
    transactionId: number,
    error?: Error,
    response?: PacketResponse,
  ): void {
    const request = this.pending.get(transactionId);
    if (!request) return;
    this.pending.delete(transactionId);
    clearTimeout(request.timeout);
    request.abortCleanup?.();
    if (error) request.reject(error);
    else request.resolve(response);
  }
}
