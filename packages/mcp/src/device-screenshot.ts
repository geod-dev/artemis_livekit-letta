import { imageType } from '@artemis/workspace';

/** The tool a connected device uses to return a screenshot. */
export const SCREENSHOT_TOOL = 'screenshot_capture';
/** A device screenshot is one PNG of at most this size. */
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/**
 * What the MCP client does with a device screenshot: how the saved file is named
 * and what counts as a valid capture. Injected through `SdkMcpClientOptions.screenshots`.
 */
export interface ScreenshotPolicy {
  /** The file name for a capture taken at `capturedAt` (epoch milliseconds). */
  fileName(deviceName: string, capturedAt: number): string;
  /** Returns the bytes when they are one PNG within the size cap; throws otherwise. */
  checkPng<T extends Uint8Array>(bytes: T | null): T;
}

export const deviceScreenshotPolicy: ScreenshotPolicy = {
  fileName(deviceName, capturedAt) {
    const safeDevice = deviceName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'device';
    return `${safeDevice}-${new Date(capturedAt).toISOString().replace(/[:.]/g, '-')}.png`;
  },
  checkPng(bytes) {
    if (!bytes || bytes.length > MAX_SCREENSHOT_BYTES || imageType(bytes) !== 'image/png') {
      throw new Error('Screenshot must be a valid PNG of at most 10 MB');
    }
    return bytes;
  },
};
