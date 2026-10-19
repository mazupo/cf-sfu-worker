import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ORIGIN } from "./helpers";

function get(path: string): Promise<Response> {
  return workerExports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual" }));
}

describe("pages", () => {
  test("the demo pages and the dashboard are under /cloudflare/, so they deploy with the route", async () => {
    for (const [path, title] of [
      ["/cloudflare/", "cf-sfu-worker viewer"],
      ["/cloudflare/device", "cf-sfu-worker device simulator"],
      ["/cloudflare/admin/", "cf-sfu-worker dashboard"],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(`<title>${title}</title>`);
    }
    expect((await get("/cloudflare/style.css")).status).toBe(200);
  });

  test("an unknown path under /cloudflare/ is still a JSON 404", async () => {
    const response = await get("/cloudflare/nothing-here");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "route_not_found" } });
  });

  test("the pages' old addresses redirect", async () => {
    for (const [from, to] of [
      ["/", "/cloudflare/"],
      ["/device", "/cloudflare/device"],
      ["/dashboard", "/cloudflare/admin/"],
    ] as const) {
      const response = await get(from);
      expect(response.status, from).toBe(302);
      expect(response.headers.get("Location"), from).toBe(to);
    }
  });
});
