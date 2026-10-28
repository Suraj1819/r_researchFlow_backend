import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const updateProfileSchema = z.object({
  full_name: z.string().min(2).max(100).optional(),
  bio: z.string().max(1000).optional().nullable(),
  registration_number: z.string().max(50).optional().nullable(),
  roll_number: z.string().max(50).optional().nullable(),
  academic_year: z.string().max(20).optional().nullable(),
  semester: z.union([z.number().int().min(1).max(12), z.string()]).optional().nullable(),
  department_id: z.string().uuid().optional().nullable(),
  skills: z.array(z.string()).optional().nullable(),
  github_url: z.string().url().optional().nullable().or(z.literal('')),
  linkedin_url: z.string().url().optional().nullable().or(z.literal('')),
  portfolio_url: z.string().url().optional().nullable().or(z.literal('')),
  avatar_url: z.string().url().optional().nullable().or(z.literal('')),
});

/**
 * GET /api/v1/me
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        email_confirmed_at: req.user.email_confirmed_at,
      },
      profile: req.profile,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/me/profile
 * Students may update permitted profile fields only.
 * Role cannot be changed through this endpoint.
 */
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const parsed = updateProfileSchema.parse(req.body);

    // Never allow role elevation via this endpoint
    const { role, id, created_at, updated_at, ...safeUpdates } = parsed;

    if (Object.keys(safeUpdates).length === 0) {
      throw AppError(400, 'NO_UPDATES', 'No valid fields to update');
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({
        ...safeUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      console.error('[me/profile]', error);
      throw AppError(500, 'UPDATE_FAILED', 'Failed to update profile');
    }

    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

export default router;
