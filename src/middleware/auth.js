
import { createUserClient, supabaseAdmin } from '../config/supabase.js';

/**
 * Verify Supabase access token and attach user + profile to req.
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (
      typeof authHeader !== 'string' ||
      !authHeader.startsWith('Bearer ') ||
      !authHeader.slice(7).trim()
    ) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid authorization header',
        },
      });
    }

    const token = authHeader.slice(7).trim();
    const supabase = createUserClient(token);

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired session',
        },
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      console.error('[auth] Profile lookup failed:', profileError.message);

      return res.status(500).json({
        error: {
          code: 'PROFILE_LOOKUP_FAILED',
          message: 'Unable to load your user profile',
        },
      });
    }

    if (!profile) {
      return res.status(403).json({
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'No profile is associated with this account',
        },
      });
    }

    req.user = user;
    req.profile = profile;
    req.accessToken = token;
    req.supabase = supabase;

    return next();
  } catch (err) {
    console.error('[auth] Authentication failed:', err.message);

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authentication failed',
      },
    });
  }
}

/**
 * Require one of the given roles.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.profile?.role;

    if (!role || !roles.includes(role)) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action',
        },
      });
    }

    return next();
  };
}
