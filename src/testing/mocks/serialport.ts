import EventEmitter from "node:events";

const WS_UPGRADE_HEADER = `GET /index.html
HTTP/1.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: 123abc

`;
const WS_UPGRADE_RESPONSE = `HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: PLOTDYCXHOTMeouth==

`;

// Stand-in for a Loupedeck serial device.
export class MockSerialPort extends EventEmitter {
  path: string | undefined;
  isOpen: boolean;
  timeout: ReturnType<typeof setTimeout>;

  static async list() {
    return [
      {
        path: "/dev/cu.usbmodem-222",
        manufacturer: "Apple",
        serialNumber: "G4429927",
        locationId: "14100001",
        vendorId: "8aaa",
        productId: "52b5",
      },
      {
        path: "/dev/cu.usbmodem-333",
        manufacturer: "Loupedeck",
        serialNumber: "LDD12345678",
        locationId: "14100000",
        vendorId: "2ec2",
        productId: "0004",
      },
    ];
  }

  constructor({ path }: { path?: string } = {}) {
    super();
    this.path = path;
    this.isOpen = false;
    this.timeout = setTimeout(
      () => {
        if (this.path === "open-error") {
          this.emit("error", new Error("open failed"));
          return;
        }
        this.isOpen = true;
        this.emit("open");
      },
      this.path === "slow-open" ? 30 : 10,
    );
  }

  close(callback?: (error?: Error | null) => void): void {
    clearTimeout(this.timeout);
    this.isOpen = false;
    queueMicrotask(() => {
      callback?.(null);
      this.emit("close");
    });
  }

  pipe(parser: { write(chunk: Buffer): unknown }): unknown {
    this.on("data", (chunk: Buffer) => parser.write(chunk));
    return parser;
  }

  write(buff: Buffer, callback?: (error?: Error | null) => void): boolean {
    queueMicrotask(() => {
      callback?.(null);
      if (
        this.path !== "no-handshake" &&
        buff.toString() === WS_UPGRADE_HEADER
      ) {
        this.emit("data", Buffer.from(WS_UPGRADE_RESPONSE));
      }
    });
    return true;
  }
}
