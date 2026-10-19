/** libsignal logs entire sessions as extra console arguments, including private keys. */
export function installConsoleDiagnostics(): void {
  const diagnostic = (first: unknown): void => {
    const message = typeof first === 'string' ? first : 'Dependency diagnostic';
    process.stderr.write(JSON.stringify({ level: 'diagnostic', message }) + '\n');
  };
  console.log = console.info = console.debug = console.warn = console.error = diagnostic;
}
