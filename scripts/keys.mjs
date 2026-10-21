// Prints a new Ed25519 key pair per role: `npm run keys`, or `npm run keys -- device` for one.
// The private key is a Worker secret; clients send the public key as `Authorization: Bearer <key>`.
import { generateKeyPairSync } from "node:crypto";

const roles = process.argv.slice(2).filter((arg) => arg === "device" || arg === "viewer");
for (const role of roles.length ? roles : ["device", "viewer"]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  // The SPKI encoding of an Ed25519 key ends with the 32-byte raw public key.
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const name = role.toUpperCase();
  console.log(`${name}_PRIVATE_KEY=${privateDer.toString("base64url")}`);
  console.log(`${name}_PUBLIC_KEY=${publicRaw.toString("base64url")}`);
  console.log("");
}
