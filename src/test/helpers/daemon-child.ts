// Separate daemon process for e2e tests: like src/daemon.ts but accepts a JSON Config override via EC_TEST_CONFIG.
import { startDaemon, parseDaemonArgs } from '../../src/daemon.ts';

const cfg = process.env['EC_TEST_CONFIG'] !== undefined ? JSON.parse(process.env['EC_TEST_CONFIG']) : {};
const d = await startDaemon({ ...parseDaemonArgs(process.argv.slice(2)), config: cfg });
process.stdout.write(JSON.stringify({ event: 'listening', port: d.port, token: d.guiToken }) + '\n');
const shutdown = (): void => { void d.stop().finally(() => process.exit(0)); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c: string) => { if (c.includes('shutdown')) shutdown(); });
process.stdin.on('end', shutdown);
