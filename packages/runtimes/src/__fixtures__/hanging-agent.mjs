// Test fixture: an "agent" CLI that never exits on its own.
// Used to exercise the real timeout / cancellation kill path end to end.
process.stdout.write("[hanging-agent] started\n");
setInterval(() => {}, 1000);
