
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ws from '../services/workspaceService.js';

const router = Router();

// Get notifications
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const notifications = await ws.listNotifications(req.user.id, {
      unreadOnly,
    });

    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

// Mark all notifications as read
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const result = await ws.markAllNotificationsRead(req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Delete all notifications for the logged-in user
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    const result = await ws.deleteAllNotifications(req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Mark one notification as read
router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const notification = await ws.markNotificationRead(
      req.params.id,
      req.user.id,
    );

    res.json({ notification });
  } catch (err) {
    next(err);
  }
});

// Delete one notification
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await ws.deleteNotification(
      req.params.id,
      req.user.id,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
