// Bindings that wrangler types cannot see: optional secrets that may not be in .dev.vars.
interface Env {
  /** Opens the dashboard's /cloudflare/admin/* on any host. Without it, only localhost gets them. */
  ADMIN_KEY?: string;
}
