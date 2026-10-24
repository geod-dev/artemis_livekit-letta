/**
 * Failures of the device connections. The hub and the upload code throw these;
 * `api.ts` maps each one to its HTTP status, as the attachment domain does.
 */
export class DeviceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The request is malformed (a bad name, tools or result). */
export class DeviceBadRequest extends DeviceError {
  constructor(message: string) {
    super(message, 400);
  }
}

/** A connected device already holds this name. */
export class DeviceNameInUse extends DeviceError {
  constructor() {
    super('Device name is in use by a connected device', 409);
  }
}

/** The request does not match the device's current state (a second poll, an unknown call). */
export class DeviceConflict extends DeviceError {
  constructor(message: string) {
    super(message, 409);
  }
}

/** The device's session lapsed or was replaced; it must register again. */
export class DeviceSessionExpired extends DeviceError {
  constructor() {
    super('Device session expired; register again', 410);
  }
}

/** The gateway is at its device limit. */
export class DeviceCapacity extends DeviceError {
  constructor(message: string) {
    super(message, 503);
  }
}

/** A file export is larger than the upload limit. */
export class DeviceRequestTooLarge extends DeviceError {
  constructor(message: string) {
    super(message, 413);
  }
}

/** A file export did not finish in time. */
export class DeviceTimeout extends DeviceError {
  constructor(message: string) {
    super(message, 408);
  }
}

/** The client of a file export left before it finished. */
export class DeviceUploadCancelled extends DeviceError {
  constructor(message: string) {
    super(message, 499);
  }
}
