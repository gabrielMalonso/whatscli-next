import { readSync, writeSync } from 'node:fs';
import { Observability } from '../../src/observability.js';

const mode = new URL(import.meta.url).searchParams.get('mode');
const record = Observability.prototype.record;
let sequence = 0;
Observability.prototype.record = function (this: Observability, category, fields = {}, origin = this.origin) {
  // Narrow fixture boundary: virtualize only retry age in the recovery control.
  if (mode === 'release') Reflect.set(this, 'elapsed', () => 0);
  record.call(this, category, {
    ...fields, query: '9'.repeat(24) + (++sequence).toString(16).padStart(8, '0'),
  }, origin);
  if (category === 'lifecycle' && fields.label === 'startup') {
    writeSync(3, 'startup-pending\n');
    if (readSync(4, Buffer.alloc(1), 0, 1, null) !== 1)
      throw new Error('Closed fictional probe gate');
  }
};
