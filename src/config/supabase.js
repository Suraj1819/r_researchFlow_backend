import { createClient } from '@supabase/supabase-js';
import { config } from './index.js';

/**
 * User-scoped client (uses anon key + forwarded Authorization header).
 * Prefer this for operations that should respect RLS.
 */
export function createUserClient(accessToken) {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Service-role client — bypasses RLS.
 * Use ONLY after explicit permission checks on the server.
 */
export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
