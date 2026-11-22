import EventEmitter from "node:events";

// Stand-in for a real WebSocket.
export class MockSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  timeout: ReturnType<typeof setTimeout>;
  readyState = this.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    this.timeout = setTimeout(() => {
      if (!this.url.startsWith("ws://") || this.url.includes("refused")) {
        const err = new Error(`connect ECONNREFUSED ${url}`);
        this.emit("error", err);
        this.finishClose(1006);
      } else {
        this.readyState = this.OPEN;
        this.emit("open");
      }
    }, 10);
  }

  close(code = 1000): void {
    if (this.readyState === this.CLOSED) return;
    clearTimeout(this.timeout);
    this.readyState = this.CLOSING;
    queueMicrotask(() => this.finishClose(code));
  }

  send(_data?: unknown, callback?: (error?: Error) => void): void {
    queueMicrotask(() => callback?.());
  }

  terminate(): void {
    this.finishClose(1006);
  }

  private finishClose(code: number): void {
    if (this.readyState === this.CLOSED) return;
    clearTimeout(this.timeout);
    this.readyState = this.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }
}
