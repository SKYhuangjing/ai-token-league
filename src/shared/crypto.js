import crypto from "node:crypto";

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
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64");
}

export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(payload)), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
