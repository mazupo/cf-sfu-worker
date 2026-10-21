// Bindings that wrangler types cannot see: optional secrets that may not be in .dev.vars.
interface Env {
  /** A TURN key of Realtime. With its API token, the worker adds TURN servers to the ICE servers. */
  REALTIME_TURN_KEY_ID?: string;
  REALTIME_TURN_KEY_API_TOKEN?: string;
  /** Opens the dashboard's /sfu/admin/* on any host. Without it, only localhost gets them. */
  ADMIN_KEY?: string;
  /** With ACCESS_AUD, Cloudflare Access protects the dashboard, e.g. https://example.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
}
