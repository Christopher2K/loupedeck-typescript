/** Base class for errors produced by the SDK. */
export class LoupedeckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An operation requires an open device connection. */
export class NotConnectedError extends LoupedeckError {
  constructor(message = "The device is not connected", options?: ErrorOptions) {
    super(message, options);
  }
}

/** The device has been intentionally closed and cannot be reopened. */
export class DeviceClosedError extends LoupedeckError {
  constructor(message = "The device is closed", options?: ErrorOptions) {
    super(message, options);
  }
}

/** A transport did not connect within the configured timeout. */
export class ConnectionTimeoutError extends LoupedeckError {
  constructor(
    message = "The connection attempt timed out",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A command was not acknowledged within the configured timeout. */
export class CommandTimeoutError extends LoupedeckError {
  constructor(
    readonly transactionId: number,
    message = `Command ${transactionId} timed out`,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The connection was lost while an operation was in progress. */
export class DisconnectedError extends LoupedeckError {
  constructor(message = "The device disconnected", options?: ErrorOptions) {
    super(message, options);
  }
}

/** An operation was cancelled through an AbortSignal. */
export class OperationAbortedError extends LoupedeckError {
  constructor(message = "The operation was aborted", options?: ErrorOptions) {
    super(message, options);
  }
}

/** A device does not support the requested operation. */
export class UnsupportedCapabilityError extends LoupedeckError {
  constructor(capability: string) {
    super(`${capability} is not available on this device`);
  }
}

/** Incoming or outgoing data does not satisfy the device protocol. */
export class ProtocolError extends LoupedeckError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** A public API argument is invalid. */
export class InvalidArgumentError extends LoupedeckError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** No transaction identifiers are available for another concurrent request. */
export class TooManyPendingRequestsError extends LoupedeckError {
  constructor() {
    super("Too many commands are waiting for device acknowledgements");
  }
}

/** Convert an unknown thrown value into an SDK-compatible Error. */
export function asError(error: unknown, fallback = "Unknown error"): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new LoupedeckError(error);
  return new LoupedeckError(fallback, { cause: error });
}
