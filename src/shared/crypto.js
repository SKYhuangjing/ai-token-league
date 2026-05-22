import crypto from "node:crypto";

const ED25519_OID = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
const LEGACY_ED25519_OID = Buffer.from([0x06, 0x03, 0x55, 0x3d, 0x65]);

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    participantId: newId("p"),
    identityPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    identityPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

export function signPayload(privateKeyPem, payload) {
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), normalizeLegacyEd25519Pem(privateKeyPem)).toString("base64");
}

export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(payload)), normalizeLegacyEd25519Pem(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function normalizeLegacyEd25519Pem(pem) {
  if (typeof pem !== "string") return pem;
  const match = pem.match(/^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----\s*$/s);
  if (!match) return pem;
  const [, label, body] = match;
  if (label !== "PUBLIC KEY" && label !== "PRIVATE KEY") return pem;
  const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
  const oidOffset = der.indexOf(LEGACY_ED25519_OID);
  if (oidOffset < 0) return pem;
  ED25519_OID.copy(der, oidOffset);
  const normalized = der.toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN ${label}-----\n${normalized}\n-----END ${label}-----\n`;
}
