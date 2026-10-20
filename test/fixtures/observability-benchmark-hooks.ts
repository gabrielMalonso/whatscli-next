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
  const states = [...observers].map((observer) => observer.status());
  const dropped = states.reduce((sum, state) => sum + state.dropped, 0);
  // The same compiled hook also runs against the exact legacy production modules.
  // Omitted modern counters mean unsupported, never inferred zero/completeness.
  const modern = states.every((state) => typeof state.uncertain === 'number' && state.buffer);
  const capture = modern ? {
    uncertain: states.reduce((sum, state) => sum + state.uncertain, 0),
    admitted: states.reduce((sum, state) => sum + state.buffer.admitted, 0),
    captured: states.reduce((sum, state) => sum + state.buffer.captured, 0),
    deferred: states.reduce((sum, state) => sum + state.buffer.deferred, 0),
    invalidated: states.reduce((sum, state) => sum + state.buffer.invalidated, 0),
    pending: states.reduce((sum, state) => sum + state.buffer.pending, 0),
    maxPending: Math.max(0, ...states.map((state) => state.buffer.maxPending)),
    maxBytes: Math.max(0, ...states.map((state) => state.buffer.maxBytes)),
  } : {};
  const cpu = process.cpuUsage();
  process.stderr.write(
    'OBS_BENCH ' +
      JSON.stringify({
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        rssBytes: process.memoryUsage.rss(),
        dropped,
        ...capture,
      }) +
      '\n',
  );
});
