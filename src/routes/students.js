import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as projectService from '../services/projectService.js';

const router = Router();

// GET /api/v1/students/search?registration_number=...&roll_number=...
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const registrationNumber = String(
      req.query.registration_number || ''
    ).trim();

    const rollNumber = String(req.query.roll_number || '').trim();

    const q = String(req.query.q || '').trim();

    const exclude = String(req.query.exclude || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!registrationNumber && !rollNumber && !q) {
      return res.status(400).json({
        error: {
          message: 'Enter a registration number or roll number.',
          code: 'SEARCH_QUERY_REQUIRED',
        },
      });
    }

    const students = await projectService.searchStudents(
      {
        registrationNumber,
        rollNumber,
        q,
      },
      exclude
    );

    return res.json({ students });
  } catch (err) {
    return next(err);
  }
});

export default router;