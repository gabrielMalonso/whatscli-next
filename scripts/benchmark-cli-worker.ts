import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { rpc as rpcType } from '../src/rpc.js';
import type { Command } from '../src/protocol.js';

const [source, directory, input] = process.argv.slice(2);
if (!source || !directory || !input) throw new Error('Expected source, directory and command');
const { rpc } = await import(pathToFileURL(source).href) as { rpc: typeof rpcType };
const command = JSON.parse(input) as Command;
const runs = [];
for (let i = 0; i < 11; i++) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  const response = await rpc(directory, command);
  const ms = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const { id: _id, ...stable } = response;
  runs.push({ ms, userMs: used.user / 1000, systemMs: used.system / 1000, peakRssBytes,
    hash: createHash('sha256').update(JSON.stringify(stable)).digest('hex') });
}
process.stdout.write(JSON.stringify(runs) + '\n');
