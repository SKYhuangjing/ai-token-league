import os from "node:os";

const interfaces = os.networkInterfaces();

console.log("=== Network Info Probe ===\n");
console.log(`Platform:   ${os.platform()} ${os.arch()}`);
console.log(`Hostname:   ${os.hostname()}`);
console.log(`Total CPUs: ${os.cpus().length}`);
console.log();

const candidates = [];

for (const [name, addrs] of Object.entries(interfaces)) {
  console.log(`[${name}]`);
  for (const addr of addrs) {
    const tag = addr.internal ? "loopback" : "LAN";
    console.log(`  ${tag}  ${addr.family}  ${addr.address}  mac=${addr.mac}`);
    if (addr.family === "IPv4" && !addr.internal) {
      candidates.push({ iface: name, address: addr.address, mac: addr.mac });
    }
  }
}

console.log("\n=== Candidates (IPv4, non-internal) ===");
if (!candidates.length) {
  console.log("  (none found)");
} else {
  for (const c of candidates) {
    console.log(`  ${c.iface.padEnd(16)} ${c.address.padEnd(16)} mac=${c.mac}`);
  }
}
