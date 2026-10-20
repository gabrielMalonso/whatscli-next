import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const write = fs.writeSync;
// Deliberately injected I/O boundary: only the fictional disable preference is shortened.
fs.writeSync = ((
  fd: number,
  data: string | NodeJS.ArrayBufferView,
  ...args: unknown[]
) => {
  if (
    typeof data === 'string' &&
    data.startsWith('{"version":1,"enabled":false,')
  )
    return write(fd, data.slice(0, 16));
  return Reflect.apply(write, fs, [fd, data, ...args]);
}) as typeof fs.writeSync;
syncBuiltinESMExports();
