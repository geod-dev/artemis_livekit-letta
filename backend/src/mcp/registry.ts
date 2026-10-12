import { type McpIo, loadMcpServers, saveMcpServers } from './service';
import { InvalidMcpServersError, type McpServer } from './settings';

/** One serialised store for manually configured and connection-managed servers. */
export class McpRegistry {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly io: McpIo,
    private readonly devices: () => McpServer[],
    private readonly changed: () => Promise<void>
  ) {}

  list(): Promise<McpServer[]> {
    return loadMcpServers(this.io);
  }

  private update(manual?: McpServer[]): Promise<void> {
    const run = this.chain.then(async () => {
      const previous = await this.list();
      const configured = manual ?? previous.filter((server) => !server.managed);
      const devices = this.devices();
      for (const device of devices)
        if (configured.some((server) => server.name === device.name)) {
          throw new InvalidMcpServersError(
            `The name ${device.name} is used by a connected device. Choose another server name.`
          );
        }
      const next = [...configured, ...devices];
      // Also updates the shared skill when reconciling after a deploy.
      await saveMcpServers(this.io, next);
      await this.changed();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Remove stale device entries after a restart and publish current connections. */
  reconcile(): Promise<void> {
    return this.update();
  }

  /** The settings API only owns manually configured entries. */
  async saveManual(servers: McpServer[]): Promise<void> {
    if (servers.some((server) => server.managed))
      throw new InvalidMcpServersError('Connected devices are managed by their connections');
    return this.update(servers);
  }
}
