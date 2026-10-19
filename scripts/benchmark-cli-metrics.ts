// Loaded into each measured CLI process; stdout remains the ordinary command response.
process.once('exit', () => {
  const usage = process.resourceUsage();
  process.stderr.write('WHATSCLI_BENCH_METRICS ' + JSON.stringify({
    userMs: usage.userCPUTime / 1000, systemMs: usage.systemCPUTime / 1000,
    peakRssBytes: usage.maxRSS * 1024,
  }) + '\n');
});
