import EventEmitter from "node:events";

// Stand-in for a real WebSocket
export class MockSocket extends EventEmitter {
  url: string;
  timeout: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    super();
    this.url = url;
    // Simulate connection attempt
    this.timeout = setTimeout(() => {
      if (!this.url.startsWith("ws://")) {
        const err = new Error(`connect ECONNREFUSED ${url}`);
        this.emit("error", err);
        this.close(1006);
      } else {
        this.emit("open");
      }
    }, 10);
  }

  close(code = 1000): void {
    clearTimeout(this.timeout);
    this.emit("close", code);
  }

  send(): void {
    // do nothing
  }

  terminate(): void {
    clearTimeout(this.timeout);
    this.emit("close", 1006);
  }
}
