import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

import {
  createDraftSchema,
  updateProjectSchema,
  addTechnologySchema,
} from '../validators/project.js';

import * as projectService from '../services/projectService.js';
import * as technologyService from '../services/technologyService.js';
import * as invitationService from '../services/invitationService.js';
import { listMyTasks } from '../services/workspaceService.js';

const router = Router();

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireUserId(req) {
  const userId = req.user?.id;

  if (!userId) {
    throw createError('Authentication is required.', 401);
  }

  return userId;
}

function requireParam(value, name) {
  if (!value || !String(value).trim()) {
    throw createError(`${name} is required.`, 400);
  }

  return String(value).trim();
}

// POST /api/v1/projects/drafts
router.post('/drafts', requireAuth, async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const payload = createDraftSchema.parse(req.body);
    const project = await projectService.createDraft(userId, payload);

    return res.status(201).json({ project });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/projects/my-tasks
router.get('/my-tasks', requireAuth, async (req, res, next) => {
  try {
    const tasks = await listMyTasks(requireUserId(req));
    return res.json({ tasks });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/projects
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const projects = await projectService.listMyProjects(
      requireUserId(req),
    );

    return res.json({ projects });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/join
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectCode = requireParam(
      req.body?.project_code,
      'Project code',
    );

    const result = await projectService.joinByProjectCode(
      userId,
      projectCode,
    );

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/projects/lookup/:code
router.get('/lookup/:code', requireAuth, async (req, res, next) => {
  try {
    const code = requireParam(req.params.code, 'Project code');
    const project = await projectService.lookupProjectByCode(code);

    if (!project) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found.',
        },
      });
    }

    return res.json({ project });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/projects/:id/invitations
router.get('/:id/invitations', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const userId = requireUserId(req);

    const invitations = await invitationService.listProjectInvitations(
      projectId,
      userId,
    );

    return res.json({ invitations });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/:id/invitations
router.post('/:id/invitations', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const userId = requireUserId(req);

    const result = await invitationService.createInvitation(
      projectId,
      userId,
      req.body || {},
    );

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/projects/:id/members
router.get('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const project = await projectService.getProjectById(
      projectId,
      requireUserId(req),
    );

    return res.json({
      members: project.members || [],
      roster: project.roster || [],
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/:id/roster
router.post('/:id/roster', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const userId = requireUserId(req);

    if (!Array.isArray(req.body?.members)) {
      throw createError('Members must be provided as an array.', 400);
    }

    const roster = await projectService.saveRoster(
      projectId,
      userId,
      req.body.members,
    );

    return res.json({ roster });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/:id/members/:studentId/remove
router.post(
  '/:id/members/:studentId/remove',
  requireAuth,
  async (req, res, next) => {
    try {
      const projectId = requireParam(req.params.id, 'Project ID');
      const studentId = requireParam(req.params.studentId, 'Student ID');

      await projectService.kickMember(
        projectId,
        requireUserId(req),
        studentId,
      );

      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

// GET /api/v1/projects/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const project = await projectService.getProjectById(
      projectId,
      requireUserId(req),
    );

    return res.json({ project });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/projects/:id
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const payload = updateProjectSchema.parse(req.body);

    const project = await projectService.updateProject(
      projectId,
      requireUserId(req),
      payload,
    );

    return res.json({ project });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/v1/projects/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');

    await projectService.deleteProject(
      projectId,
      requireUserId(req),
    );

    return res.json({
      success: true,
      message: 'Project deleted successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/:id/submit
router.post('/:id/submit', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');

    const project = await projectService.submitProject(
      projectId,
      requireUserId(req),
    );

    return res.json({ project });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/projects/:id/technologies
router.post('/:id/technologies', requireAuth, async (req, res, next) => {
  try {
    const projectId = requireParam(req.params.id, 'Project ID');
    const payload = addTechnologySchema.parse(req.body);

    const technology = await technologyService.addProjectTechnology(
      projectId,
      requireUserId(req),
      payload,
    );

    return res.status(201).json({ technology });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/projects/:id/technologies/:technologyId
router.patch(
  '/:id/technologies/:technologyId',
  requireAuth,
  async (req, res, next) => {
    try {
      const projectId = requireParam(req.params.id, 'Project ID');
      const technologyId = requireParam(
        req.params.technologyId,
        'Technology ID',
      );

      const technology = await technologyService.updateProjectTechnology(
        projectId,
        technologyId,
        requireUserId(req),
        req.body,
      );

      return res.json({ technology });
    } catch (err) {
      return next(err);
    }
  },
);

// DELETE /api/v1/projects/:id/technologies/:technologyId
router.delete(
  '/:id/technologies/:technologyId',
  requireAuth,
  async (req, res, next) => {
    try {
      const projectId = requireParam(req.params.id, 'Project ID');
      const technologyId = requireParam(
        req.params.technologyId,
        'Technology ID',
      );

      await technologyService.removeProjectTechnology(
        projectId,
        technologyId,
        requireUserId(req),
      );

      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;