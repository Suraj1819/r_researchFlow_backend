
import { Router } from 'express';
import meRouter from './me.js';
import healthRouter from './health.js';
import projectsRouter from './projects.js';
import invitationsRouter from './invitations.js';
import technologiesRouter from './technologies.js';
import studentsRouter from './students.js';
import workspaceRouter from './workspace.js';
import notificationsRouter from './notifications.js';
import groupsRouter from './groups.js';
import reviewsRouter from './reviews.js';
import ideasRouter from './ideas.js';
import adminRouter from './admin.js';
import supervisionRouter from './supervision.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/me', meRouter);

// Projects
router.use('/projects', projectsRouter);

// Project workspace
router.use('/projects/:id', workspaceRouter);

// Invitations
router.use('/invitations', invitationsRouter);

// Technologies and students
router.use('/technologies', technologiesRouter);
router.use('/students', studentsRouter);

// Notifications, groups, reviews and ideas
router.use('/notifications', notificationsRouter);
router.use('/groups', groupsRouter);
router.use('/reviews', reviewsRouter);
router.use('/ideas', ideasRouter);

// Admin
router.use('/admin', adminRouter);

// Meetings & Supervision
router.use('/supervision', supervisionRouter);

export default router;
