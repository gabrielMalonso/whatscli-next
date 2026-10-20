import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { installConsoleDiagnostics } from './diagnostics.js';
import { parseRequest, RequestError } from './protocol.js';
import { createRuntime } from './runtime.js';
import { encode } from './store.js';
import { errorResponse } from './errors.js';

process.umask(0o077);
installConsoleDiagnostics();

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string', default: '.private/probe' },
    connect: { type: 'boolean', default: false },
    'test-jid': { type: 'string' },
  } });
  const runtime = createRuntime({
    dataDir: values['data-dir'], connect: values.connect, requireAllowedJid: true,
    ...(values['test-jid'] === undefined ? {} : { allowedJid: values['test-jid'] }),
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stopInput = (): void => { void runtime.stop().then(() => input.close()); };
  process.once('SIGINT', stopInput);
  process.once('SIGTERM', stopInput);
  try {
    runtime.start();
    for await (const line of input) {
      let id: string | null = null;
      try {
        const request = parseRequest(line);
        id = request.id;
        const data = await runtime.execute(request.command);
        process.stdout.write(encode({ id, ok: true, data, ...runtime.snapshot() }) + '\n');
        if (request.command.command === 'stop') break;
      } catch (error) {
        process.stdout.write(encode({ id: error instanceof RequestError ? error.id : id, ...errorResponse(error) }) + '\n');
      }
    }
  } finally { input.close(); await runtime.close(); }
}

main().catch(error => {
  process.stderr.write(encode(errorResponse(error)) + '\n');
  process.exitCode = 1;
});
