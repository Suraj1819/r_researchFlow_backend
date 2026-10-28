import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import * as reviewService from '../services/reviewService.js';

const router = Router();

// Public-ish: published ideas (auth optional but we require auth for simplicity)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isAdmin = req.profile && ['coordinator', 'admin', 'faculty'].includes(req.profile.role);
    const ideas = await reviewService.listIdeas({ publishedOnly: !isAdmin || req.query.all !== 'true' });
    res.json({ ideas });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const idea = await reviewService.getIdea(req.params.id);
    res.json({ idea });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      title: z.string().min(5).max(200),
      problem_statement: z.string().max(5000).optional().nullable(),
      description: z.string().max(5000).optional().nullable(),
      suggested_features: z.array(z.string()).optional(),
      recommended_technologies: z.array(z.string()).optional(),
      difficulty: z.enum(['easy', 'medium', 'hard', 'advanced']).optional(),
      estimated_duration: z.string().optional().nullable(),
      expected_outcome: z.string().optional().nullable(),
      category_id: z.string().uuid().optional().nullable(),
      is_published: z.boolean().optional(),
    });
    const payload = schema.parse(req.body);
    const idea = await reviewService.createIdea(req.user.id, req.profile, payload);
    res.status(201).json({ idea });
  } catch (err) {
    next(err);
  }
});

// Use idea → create draft
router.post('/:id/use', requireAuth, async (req, res, next) => {
  try {
    const project = await reviewService.useIdeaAsDraft(req.params.id, req.user.id);
    res.status(201).json({ project });
  } catch (err) {
    next(err);
  }
});

export default router;
