import { writeSync } from 'node:fs';
import { Observability } from '../../src/observability.js';
const observers = new Set<Observability>();
const record = Observability.prototype.record;
Observability.prototype.record = function (
  this: Observability,
  category,
  fields = {},
  origin = this.origin,
) {
  observers.add(this);
  record.call(this, category, fields, origin);
  if (category === 'lifecycle' && fields.label === 'startup') {
    // Event loop cannot process the parent's readiness RPC until startup/listen finishes.
    writeSync(3, 'ready\n');
  }
};
process.once('exit', () => {
  const dropped = [...observers].reduce(
    (sum, observer) => sum + observer.status().dropped,
    0,
  );
  const cpu = process.cpuUsage();
  process.stderr.write(
    'OBS_BENCH ' +
      JSON.stringify({
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        rssBytes: process.memoryUsage.rss(),
        dropped,
      }) +
      '\n',
  );
});
