// Fetches external/protocol when it is empty (Workers Builds does not clone submodules),
// and warns when it is not at the commit this repo records.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const PROTO = "external/protocol/protos/cloudflare.proto";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

if (!existsSync(PROTO)) {
  try {
    execFileSync("git", ["submodule", "update", "--init", "external/protocol"], { stdio: "inherit" });
  } catch {}
  if (!existsSync(PROTO)) {
    console.error("external/protocol is empty. Run `git submodule update --init`, or clone with `git clone --recursive`.");
    process.exit(1);
  }
}

let recorded;
let checkedOut;
try {
  recorded = git("rev-parse", "HEAD:external/protocol");
  checkedOut = git("-C", "external/protocol", "rev-parse", "HEAD");
} catch {
  process.exit(0); // not a git checkout
}
if (recorded !== checkedOut) {
  console.warn(
    `\x1b[33mWarning: external/protocol is at ${checkedOut.slice(0, 7)}, but this commit records ${recorded.slice(0, 7)}.\n` +
      `src/proto is built from the checkout. Run \`git submodule update\` unless you are changing the messages.\x1b[0m`,
  );
}
