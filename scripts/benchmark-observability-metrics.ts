// Fresh child: CPU totals include Node/import/startup; RSS is current at exit, never maxRSS.
process.once('exit', () => {
  const cpu = process.cpuUsage();
  process.stderr.write('OBS_BENCH ' + JSON.stringify({ userMs: cpu.user / 1000, systemMs: cpu.system / 1000,
    rssBytes: process.memoryUsage.rss(), heapBytes: process.memoryUsage().heapUsed }) + '\n');
});
