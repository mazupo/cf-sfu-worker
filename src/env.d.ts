// Bindings that wrangler types cannot see: optional secrets that may not be in .dev.vars.
interface Env {
  /** A Realtime TURN key. With its API token, devices and viewers also get TURN servers. */
  REALTIME_TURN_KEY_ID?: string;
  REALTIME_TURN_KEY_API_TOKEN?: string;
  /** Opens the dashboard on any host. Without it, only on localhost. */
  ADMIN_KEY?: string;
  /** With ACCESS_AUD, Cloudflare Access protects the dashboard. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
}
