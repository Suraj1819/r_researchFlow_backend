
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import * as groupService from '../services/groupService.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
    const allowed = ['ppt', 'pptx', 'pdf'];

    if (!allowed.includes(ext)) {
      const error = new Error('Only PPT, PPTX or PDF files are allowed');
      error.status = 400;
      return callback(error);
    }

    callback(null, true);
  },
});

const idSchema = z.string().min(1);

const saveSchema = z.object({
  team_name: z.string().trim().min(1).max(120),
  member_names: z.array(z.string().trim().max(160)).optional(),
  project_title: z.string().trim().min(1).max(200),
  project_summary: z.string().max(20000).nullable().optional(),
  project_id: z.string().nullable().optional(),
  github_url: z.string().max(2000).nullable().optional(),
  linkedin_url: z.string().max(2000).nullable().optional(),
  demo_url: z.string().max(2000).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  extra_links: z.array(z.unknown()).optional(),
  submit: z.boolean().optional().default(false),
});

const resubmissionRequestSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
});

const resubmissionReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  feedback: z.string().trim().max(2000).optional().default(''),
});

const groupCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).nullable().optional(),
  academic_year: z.string().trim().min(1).max(100),
  semester: z.union([z.string(), z.number()]).nullable().optional(),
  branch: z.string().max(200).nullable().optional(),
  session_year: z.string().max(100).nullable().optional(),
  coordinator_name: z.string().max(200).nullable().optional(),
  starts_at: z.string().nullable().optional(),
  submission_deadline: z.string().nullable().optional(),
  is_published: z.boolean().optional(),
});

const groupUpdateSchema = groupCreateSchema.partial();

function parseBody(schema, body) {
  const result = schema.safeParse(body);

  if (!result.success) {
    const error = new Error(
      result.error.issues.map((issue) => issue.message).join(', ')
    );
    error.status = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  return result.data;
}

function getUserId(req) {
  return req.user?.id || req.user?.user_id || req.auth?.userId;
}

function getProfile(req) {
  return req.profile || req.user?.profile || req.auth?.profile;
}

function requireIdentity(req) {
  const userId = getUserId(req);
  const profile = getProfile(req);

  if (!userId || !profile) {
    const error = new Error('Authenticated user profile is missing');
    error.status = 401;
    error.code = 'UNAUTHENTICATED';
    throw error;
  }

  return { userId, profile };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function validateId(value, label = 'ID') {
  const result = idSchema.safeParse(value);

  if (!result.success) {
    const error = new Error(`Invalid ${label}`);
    error.status = 400;
    error.code = 'INVALID_INPUT';
    throw error;
  }

  return result.data;
}

// List groups
router.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const groups = await groupService.listGroups(profile, userId);

    res.json({ groups });
  })
);

// Create group
router.post(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const payload = parseBody(groupCreateSchema, req.body);

    const group = await groupService.createGroup(
      userId,
      profile,
      payload
    );

    res.status(201).json({ group });
  })
);

// Get group and submissions
router.get(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');

    const result = await groupService.getGroup(
      groupId,
      userId,
      profile
    );

    res.json(result);
  })
);

// Update group
router.patch(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');
    const payload = parseBody(groupUpdateSchema, req.body);

    const group = await groupService.updateGroup(
      groupId,
      userId,
      profile,
      payload
    );

    res.json({ group });
  })
);

// Delete group
router.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');

    const result = await groupService.deleteGroup(
      groupId,
      userId,
      profile
    );

    res.json(result);
  })
);

// Join group
router.post(
  '/:id/join',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');

    const result = await groupService.joinGroup(groupId, userId);

    res.json(result);
  })
);

// Save draft or submit project
router.patch(
  '/:id/submission',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');
    const payload = parseBody(saveSchema, req.body);

    const submission = await groupService.saveSubmission(
      groupId,
      userId,
      payload
    );

    res.json({ submission });
  })
);

// Upload or replace presentation
router.post(
  '/:id/ppt',
  requireAuth,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const { userId } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');

    if (!req.file) {
      const error = new Error('Choose a PPT, PPTX or PDF file');
      error.status = 400;
      error.code = 'FILE_REQUIRED';
      throw error;
    }

    const submission = await groupService.uploadPpt(
      groupId,
      userId,
      req.file
    );

    res.json({ submission });
  })
);

// Student requests permission to resubmit
router.post(
  '/:id/resubmission-request',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');
    const payload = parseBody(resubmissionRequestSchema, req.body);

    const submission = await groupService.requestResubmission(
      groupId,
      userId,
      payload.reason
    );

    res.json({
      message: 'Resubmission request sent to faculty',
      submission,
    });
  })
);

// Faculty reviews a pending resubmission request
router.post(
  '/:id/submissions/:submissionId/resubmission-review',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');
    const submissionId = validateId(
      req.params.submissionId,
      'submission ID'
    );
    const payload = parseBody(resubmissionReviewSchema, req.body);

    if (payload.decision === 'rejected' && !payload.feedback.trim()) {
      const error = new Error('Feedback is required when rejecting a request');
      error.status = 400;
      error.code = 'FEEDBACK_REQUIRED';
      throw error;
    }

    const submission = await groupService.reviewResubmission(
      groupId,
      submissionId,
      userId,
      profile,
      payload
    );

    res.json({
      message:
        payload.decision === 'approved'
          ? 'Resubmission request approved'
          : 'Resubmission request rejected',
      submission,
    });
  })
);

// Delete uploaded presentation
router.delete(
  '/:id/submissions/:submissionId/ppt',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { userId, profile } = requireIdentity(req);

    const groupId = validateId(req.params.id, 'group ID');
    const submissionId = validateId(
      req.params.submissionId,
      'submission ID'
    );

    const result = await groupService.deletePpt(
      groupId,
      submissionId,
      userId,
      profile
    );

    res.json({
      message: 'Presentation deleted successfully',
      ...result,
    });
  })
);

// Faculty downloads a submitted presentation
router.get(
  '/:id/submissions/:submissionId/ppt',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { profile } = requireIdentity(req);
    const groupId = validateId(req.params.id, 'group ID');
    const submissionId = validateId(
      req.params.submissionId,
      'submission ID'
    );

    const result = await groupService.getPptUrl(
      groupId,
      submissionId,
      profile
    );

    res.json(result);
  })
);

export default router;
