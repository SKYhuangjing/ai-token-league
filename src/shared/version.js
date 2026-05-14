import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const CLIENT_PROTOCOL_VERSION = 2;
export const SERVER_PROTOCOL_VERSION = 2;
export const SNAPSHOT_PROTOCOL_VERSION = 2;
export const SUPPORTED_CLIENT_PROTOCOL = { min: 1, max: 2 };
export const SUPPORTED_SERVER_PROTOCOL = { min: 1, max: 2 };

export function packageVersion(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = packageVersion();
export const SERVER_VERSION = APP_VERSION;

export function productBaseline(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    return String(pkg.productBaseline || pkg.version?.replace(/\.\d+$/, "") || "0.0");
  } catch {
    return "0.0";
  }
}

export const PRODUCT_BASELINE = productBaseline();

export function clientPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return `${platform}-${arch}`;
}

export function clientBuild({ build = process.env.CLIENT_BUILD || "" } = {}) {
  return build || `${clientPlatform()}-${APP_VERSION}`;
}

export function clientMetadata(overrides = {}) {
  return {
    clientAppVersion: APP_VERSION,
    clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
    clientPlatform: clientPlatform(),
    clientBuild: clientBuild(),
    runtime: `node-${process.version}`,
    os: `${os.platform()}-${os.arch()}`,
    ...overrides
  };
}

export function normalizeClientMetadata(input = {}) {
  return {
    clientAppVersion: safeText(input.clientAppVersion || input.appVersion),
    clientProtocolVersion: input.clientProtocolVersion === undefined ? null : Number(input.clientProtocolVersion),
    clientPlatform: safeText(input.clientPlatform || input.platform || input.os),
    clientBuild: safeText(input.clientBuild || input.build)
  };
}

export function compatibilityResult(metadata = {}, options = {}) {
  const policy = {
    minClientProtocol: SUPPORTED_CLIENT_PROTOCOL.min,
    maxClientProtocol: SUPPORTED_CLIENT_PROTOCOL.max,
    latestClientVersion: APP_VERSION,
    minClientEnforce: false,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    serverVersion: SERVER_VERSION,
    ...options
  };
  const normalized = normalizeClientMetadata(metadata);
  const protocol = normalized.clientProtocolVersion;
  const base = {
    status: "compatible",
    compatible: true,
    mandatory: false,
    reason: "",
    client: normalized,
    server: {
      serverVersion: policy.serverVersion,
      serverProtocolVersion: policy.serverProtocolVersion,
      supportedClientProtocol: {
        min: policy.minClientProtocol,
        max: policy.maxClientProtocol
      },
      latestClientVersion: policy.latestClientVersion,
      minClientEnforce: policy.minClientEnforce || false
    }
  };
  if (protocol === null) {
    return {
      ...base,
      status: "upgrade_recommended",
      compatible: true,
      mandatory: false,
      reason: "missing_client_protocol"
    };
  }
  if (Number.isNaN(protocol) || !Number.isInteger(protocol) || protocol < 0) {
    return {
      ...base,
      status: "unsupported_client",
      compatible: false,
      mandatory: true,
      reason: "malformed_client_protocol"
    };
  }
  if (protocol < policy.minClientProtocol) {
    return {
      ...base,
      status: "unsupported_client",
      compatible: false,
      mandatory: true,
      reason: "client_protocol_too_old"
    };
  }
  if (protocol > policy.maxClientProtocol) {
    return {
      ...base,
      status: "unsupported_server",
      compatible: false,
      mandatory: true,
      reason: "client_protocol_too_new"
    };
  }
  if (normalized.clientAppVersion && compareSemver(normalized.clientAppVersion, policy.latestClientVersion) < 0) {
    if (policy.minClientEnforce) {
      return {
        ...base,
        status: "unsupported_client",
        compatible: false,
        mandatory: true,
        reason: "client_app_version_too_old"
      };
    }
    return {
      ...base,
      status: "upgrade_available",
      compatible: true,
      mandatory: false,
      reason: "newer_client_available"
    };
  }
  return base;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function parseSemver(value) {
  const match = String(value || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function safeText(value) {
  return String(value || "").trim().slice(0, 160);
}

export function collectNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const lanIps = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && addr.mac !== "00:00:00:00:00:00") {
        lanIps.push(addr.address);
      }
    }
  }
  return { lanIps };
}
