// Bindings that wrangler types cannot see: optional secrets that may not be in .dev.vars.
interface Env {
  /** Opens the dashboard's /cloudflare/admin/* on any host. Without it, only localhost gets them. */
  ADMIN_KEY?: string;
  /** With ACCESS_AUD, Cloudflare Access protects the dashboard, e.g. https://example.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
}
