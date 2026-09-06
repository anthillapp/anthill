// Test fixture: an "agent" CLI that fails. Writes to stderr and exits 3.
process.stderr.write("fatal: could not reach the model endpoint\n");
process.exit(3);
