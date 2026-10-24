import type { McpServer } from '@artemis/contracts/chat-types';

/** The device registry the sync reads and listens to. */
export interface DeviceSource {
  servers(): McpServer[];
  onChange(listener: () => Promise<void>): void;
}

/** The agent-server call that receives the managed MCP servers. */
export interface ManagedMcpTarget {
  setManagedMcp(servers: McpServer[]): Promise<void>;
}

/** The agent-server reports devices again this often, so a restarted instance learns them too. */
const DEVICE_SYNC_EVERY_MS = 30_000;

/**
 * Keeps the agent-server's managed MCP servers equal to the connected devices. Each
 * push sends the whole list, one push at a time, so the last push carries the current
 * list. A failed push rejects to its caller, so the device registry can retry it.
 */
export class DeviceSync {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      devices: DeviceSource;
      agent: ManagedMcpTarget;
      everyMs?: number;
    }
  ) {}

  /** Pushes the current device list after the pushes already queued. */
  push(): Promise<void> {
    this.chain = this.chain
      .catch(() => {})
      .then(() => this.options.agent.setManagedMcp(this.options.devices.servers()));
    return this.chain;
  }

  /** Listens for device changes, pushes once now, then re-pushes on the periodic timer. */
  start(): void {
    this.options.devices.onChange(() => this.push());
    void this.report();
    this.timer = setInterval(
      () => void this.report(),
      this.options.everyMs ?? DEVICE_SYNC_EVERY_MS
    );
    this.timer.unref();
  }

  /** Stops the periodic push. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private report(): Promise<void> {
    return this.push().catch((error) =>
      console.error('[devices] could not sync devices to the agent-server', error)
    );
  }
}
