// Checks that each env in wrangler.jsonc repeats the top-level vars, Durable Objects and rate limits.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const config = JSON.parse(stripComments(readFileSync("wrangler.jsonc", "utf8")));
const limits = (list = []) => list.map(({ namespace_id, ...rest }) => rest);
const ids = (list = []) => list.map((limit) => limit.namespace_id);

const problems = [];
for (const [name, env] of Object.entries(config.env ?? {})) {
  if (!isDeepStrictEqual(env.vars, config.vars)) problems.push(`env.${name}.vars differ from vars.`);
  if (!isDeepStrictEqual(env.durable_objects, config.durable_objects)) {
    problems.push(`env.${name}.durable_objects differ from durable_objects.`);
  }
  if (!isDeepStrictEqual(limits(env.ratelimits), limits(config.ratelimits))) {
    problems.push(`env.${name}.ratelimits differ from ratelimits.`);
  }
  if (ids(env.ratelimits).some((id) => ids(config.ratelimits).includes(id))) {
    problems.push(`env.${name}.ratelimits reuse a namespace_id, so both deployments would share the counts.`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

/** Drops the comments, keeping strings such as "example.com/sfu/*". */
function stripComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : ""));
}
