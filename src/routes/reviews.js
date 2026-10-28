
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import * as reviewService from '../services/reviewService.js';

const router = Router();

const reviewSchema = z.object({
  decision: z.enum(['changes_requested', 'approved', 'rejected']),
  overall_comment: z.string().max(5000).optional().nullable(),
  requested_changes: z.string().max(5000).optional().nullable(),
  rubric_id: z.string().uuid().optional().nullable(),
  scores: z.record(z.string(), z.number().finite().min(0)).optional(),
});

// GET /api/v1/reviews/queue
router.get('/queue', requireAuth, async (req, res, next) => {
  try {
    const projects = await reviewService.getReviewQueue(req.profile, {
      status: req.query.status,
      reviewerId: req.user.id,
    });

    res.json({ projects });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/reviews/rubrics
router.get('/rubrics', requireAuth, async (_req, res, next) => {
  try {
    const rubrics = await reviewService.listRubrics();
    res.json({ rubrics });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/reviews/:projectId/resubmit
router.post('/:projectId/resubmit', requireAuth, async (req, res, next) => {
  try {
    const project = await reviewService.resubmitProject(
      req.params.projectId,
      req.user.id,
    );

    res.json({ project });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/reviews/:projectId
router.post('/:projectId', requireAuth, async (req, res, next) => {
  try {
    const payload = reviewSchema.parse(req.body);

    const review = await reviewService.submitReview(
      req.params.projectId,
      req.user.id,
      req.profile,
      payload,
    );

    res.status(201).json({ review });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/reviews/project/:projectId
router.get('/project/:projectId', requireAuth, async (req, res, next) => {
  try {
    const reviews = await reviewService.getProjectReviews(
      req.params.projectId,
      req.user.id,
      req.profile,
    );

    res.json({ reviews });
  } catch (error) {
    next(error);
  }
});

export default router;
