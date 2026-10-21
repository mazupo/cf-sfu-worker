// Makes sure external/protocol holds the protos at the commit in package.json.
// A copy made by the Deploy to Cloudflare button has no submodule, so the protos are downloaded.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "external/protocol/protos";
// The protos buf.gen.yaml generates; their imports come along.
const ROOTS = ["cloudflare.proto", "packet.proto"];
const { repo, commit } = JSON.parse(readFileSync("package.json", "utf8")).protocol;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

if (!existsSync(`${DIR}/${ROOTS[0]}`)) {
  try {
    execFileSync("git", ["submodule", "update", "--init", "external/protocol"], { stdio: "ignore" });
  } catch {}
}
if (!existsSync(`${DIR}/${ROOTS[0]}`)) await download();

let recorded;
let checkedOut;
try {
  recorded = git("rev-parse", "HEAD:external/protocol");
  checkedOut = git("-C", "external/protocol", "rev-parse", "HEAD");
} catch {
  process.exit(0); // no submodule: the downloaded protos are at `commit`
}
if (recorded !== commit) {
  console.error(`package.json has protocol.commit ${commit.slice(0, 7)}, but the submodule records ${recorded.slice(0, 7)}. Make them match.`);
  process.exit(1);
}
if (recorded !== checkedOut) {
  console.warn(
    `\x1b[33mWarning: external/protocol is at ${checkedOut.slice(0, 7)}, but this commit records ${recorded.slice(0, 7)}.\n` +
      `src/proto is built from the checkout. Run \`git submodule update\` unless you are changing the messages.\x1b[0m`,
  );
}

async function download() {
  mkdirSync(DIR, { recursive: true });
  const queue = [...ROOTS];
  const done = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (done.has(name) || name.startsWith("google/")) continue;
    done.add(name);
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/protos/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Could not download ${url}: ${response.status}. Run \`git submodule update --init\` instead.`);
      process.exit(1);
    }
    const text = await response.text();
    writeFileSync(`${DIR}/${name}`, text);
    for (const [, imported] of text.matchAll(/^import\s+"([^"]+)";/gm)) queue.push(imported);
  }
  console.log(`Downloaded ${[...done].join(", ")} from ${repo}@${commit.slice(0, 7)}.`);
}
