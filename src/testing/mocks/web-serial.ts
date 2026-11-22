const UPGRADE_HEADER = "GET /index.html";

export class MockWebSerialPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly writes: Uint8Array[] = [];
  handshakeChunks: Uint8Array[] = [
    new TextEncoder().encode("HTTP/1.1 101 Switching Protocols\n\n"),
  ];
  openCalls = 0;
  closeCalls = 0;
  private readableController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;
  private closed = false;

  constructor(
    readonly usbVendorId = 0x2ec2,
    readonly usbProductId = 4,
  ) {
    super();
  }

  async open(): Promise<void> {
    this.openCalls++;
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readableController = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writes.push(chunk);
        if (new TextDecoder().decode(chunk).startsWith(UPGRADE_HEADER)) {
          for (const response of this.handshakeChunks) {
            this.readableController?.enqueue(response);
          }
        }
      },
    });
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (!this.closed) {
      try {
        this.readableController?.close();
      } catch {
        // Cancelling a reader may already have closed the stream.
      }
    }
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }

  async getInfo() {
    return {
      usbVendorId: this.usbVendorId,
      usbProductId: this.usbProductId,
    };
  }

  push(data: Uint8Array): void {
    this.readableController?.enqueue(data);
  }

  fail(error: Error): void {
    this.readableController?.error(error);
  }
}

export function asSerialPort(port: MockWebSerialPort): SerialPort {
  return port as unknown as SerialPort;
}
