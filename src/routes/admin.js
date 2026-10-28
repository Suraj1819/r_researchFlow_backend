import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as reviewService from '../services/reviewService.js';

const router = Router();

router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const stats = await reviewService.getCoordinatorStats(req.profile);
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const categories = await reviewService.listCategories();
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

export default router;
