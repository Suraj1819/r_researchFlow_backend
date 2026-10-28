import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as technologyService from '../services/technologyService.js';

const router = Router();

// GET /api/v1/technologies
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { category, search } = req.query;
    const technologies = await technologyService.listTechnologies({ category, search });
    res.json({ technologies });
  } catch (err) {
    next(err);
  }
});

export default router;
