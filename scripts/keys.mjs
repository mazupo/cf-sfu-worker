// Prints a fresh Ed25519 key pair for one role (device or viewer).
//
//   npm run keys            -> prints both roles
//   npm run keys -- device  -> prints only the device key pair
//
// The private key goes into a Worker secret (DEVICE_PRIVATE_KEY or VIEWER_PRIVATE_KEY).
// The public key is what devices or viewers send as `Authorization: Bearer <public key>`.
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
