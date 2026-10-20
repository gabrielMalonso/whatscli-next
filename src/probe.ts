import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { installConsoleDiagnostics } from './diagnostics.js';
import { parseRequest, RequestError } from './protocol.js';
import { createRuntime } from './runtime.js';
import { encode } from './store.js';
import { errorResponse } from './errors.js';
import { obsAction, obsCode } from './observability.js';
import type { ObsFields } from './observability.js';
import { commandFields, wireFields } from './observability-context.js';

process.umask(0o077);
installConsoleDiagnostics();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string', default: '.private/probe' },
      connect: { type: 'boolean', default: false },
      'test-jid': { type: 'string' },
    },
  });
  const runtime = createRuntime({
    dataDir: values['data-dir'],
    connect: values.connect,
    requireAllowedJid: true,
    ...(values['test-jid'] === undefined
      ? {}
      : { allowedJid: values['test-jid'] }),
  });
  installConsoleDiagnostics(() =>
    runtime.observability.record('diagnostic', { label: 'dependency' }),
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stopInput = (): void => {
    void runtime.stop().then(() => input.close());
  };
  process.once('SIGINT', stopInput);
  process.once('SIGTERM', stopInput);
  try {
    runtime.start();
    for await (const line of input) {
      let id: string | null = null;
      let fields: ObsFields = { action: 'unknown' };
      let capture = true;
      let parsed = false;
      const started = performance.now();
      const respond = (response: Record<string, unknown>): void => {
        const output = encode(response) + '\n';
        process.stdout.write(output);
        if (capture)
          runtime.observability.record(
            parsed ? 'transport' : 'parser',
            {
              ...fields,
              durationMs: performance.now() - started,
              requestBytes: Buffer.byteLength(line),
              stdoutBytes: Buffer.byteLength(output),
              ok: response.ok === true,
              code: response.ok === true ? 'OK' : obsCode(response.code),
            },
            'probe',
          );
      };
      try {
        const request = parseRequest(line);
        parsed = true;
        id = request.id;
        fields = {
          ...commandFields(runtime.observability, request.command),
          ...wireFields(runtime.observability, id),
        };
        capture = request.command.command !== 'observability';
        const data = await runtime.execute(
          request.command,
          wireFields(runtime.observability, id),
        );
        respond({ id, ok: true, data, ...runtime.snapshot() });
        if (request.command.command === 'stop') break;
      } catch (error) {
        if (error instanceof RequestError) {
          fields = {
            action: obsAction(error.action),
            ...wireFields(runtime.observability, error.id),
          };
        }
        respond({
          id: error instanceof RequestError ? error.id : id,
          ...errorResponse(error),
        });
      }
    }
  } finally {
    input.close();
    await runtime.close();
  }
}

main().catch((error) => {
  process.stderr.write(encode(errorResponse(error)) + '\n');
  process.exitCode = 1;
});
