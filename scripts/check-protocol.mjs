// Warns when external/protocol is not at the commit this repo records. `npm run proto` builds
// src/proto from whatever is checked out there, so an old checkout drops fields the code uses.
// It only warns: while you change the messages, the submodule is ahead on purpose.
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

let recorded;
let checkedOut;
try {
  recorded = git("rev-parse", "HEAD:external/protocol");
  checkedOut = git("-C", "external/protocol", "rev-parse", "HEAD");
} catch {
  process.exit(0); // not a git checkout, e.g. a downloaded copy
}
if (recorded !== checkedOut) {
  console.warn(
    `\x1b[33mWarning: external/protocol is at ${checkedOut.slice(0, 7)}, but this commit records ${recorded.slice(0, 7)}.\n` +
      `src/proto is built from the checkout. Run \`git submodule update\` unless you are changing the messages.\x1b[0m`,
  );
}
