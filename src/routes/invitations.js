
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as invitationService from '../services/invitationService.js';

const router = Router({ mergeParams: true });

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ''
  ) {
    throw createError(`${fieldName} is required.`, 400);
  }

  return String(value).trim();
}

// GET /api/v1/invitations
// GET /api/v1/projects/:id/invitations
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw createError('Authentication is required.', 401);
    }

    const projectId = req.params.id;

    if (projectId) {
      const invitations =
        await invitationService.listProjectInvitations(
          validateId(projectId, 'Project ID'),
          userId,
        );

      return res.status(200).json({ invitations });
    }

    const invitations =
      await invitationService.listMyInvitations(userId);

    return res.status(200).json({ invitations });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/invitations/:id/accept
router.post('/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw createError('Authentication is required.', 401);
    }

    const invitationId = validateId(
      req.params.id,
      'Invitation ID',
    );

    const result = await invitationService.respondToInvitation(
      invitationId,
      userId,
      true,
    );

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/invitations/:id/decline
router.post('/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw createError('Authentication is required.', 401);
    }

    const invitationId = validateId(
      req.params.id,
      'Invitation ID',
    );

    const result = await invitationService.respondToInvitation(
      invitationId,
      userId,
      false,
    );

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
