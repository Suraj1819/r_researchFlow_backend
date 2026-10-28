import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import * as ws from '../services/workspaceService.js';
import {
  createModuleSchema,
  createTaskSchema,
  createMilestoneSchema,
} from '../validators/project.js';

const router = Router({ mergeParams: true });

// Modules
router.get('/modules', requireAuth, async (req, res, next) => {
  try {
    const modules = await ws.listModules(req.params.id, req.user.id);
    res.json({ modules });
  } catch (err) {
    next(err);
  }
});

router.post('/modules', requireAuth, async (req, res, next) => {
  try {
    const payload = createModuleSchema.parse(req.body);
    const mod = await ws.createModule(req.params.id, req.user.id, payload);
    res.status(201).json({ module: mod });
  } catch (err) {
    next(err);
  }
});

router.patch('/modules/:moduleId', requireAuth, async (req, res, next) => {
  try {
    const mod = await ws.updateModule(req.params.id, req.params.moduleId, req.user.id, req.body);
    res.json({ module: mod });
  } catch (err) {
    next(err);
  }
});

// Tasks
router.get('/tasks', requireAuth, async (req, res, next) => {
  try {
    const tasks = await ws.listTasks(req.params.id, req.user.id);
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks', requireAuth, async (req, res, next) => {
  try {
    const payload = createTaskSchema.parse(req.body);
    const task = await ws.createTask(req.params.id, req.user.id, payload);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

router.patch('/tasks/:taskId', requireAuth, async (req, res, next) => {
  try {
    const task = await ws.updateTask(req.params.id, req.params.taskId, req.user.id, req.body);
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// Milestones
router.get('/milestones', requireAuth, async (req, res, next) => {
  try {
    const milestones = await ws.listMilestones(req.params.id, req.user.id);
    res.json({ milestones });
  } catch (err) {
    next(err);
  }
});

router.post('/milestones', requireAuth, async (req, res, next) => {
  try {
    const payload = createMilestoneSchema.parse(req.body);
    const milestone = await ws.createMilestone(req.params.id, req.user.id, payload);
    res.status(201).json({ milestone });
  } catch (err) {
    next(err);
  }
});

router.patch('/milestones/:milestoneId', requireAuth, async (req, res, next) => {
  try {
    const milestone = await ws.updateMilestone(
      req.params.id,
      req.params.milestoneId,
      req.user.id,
      req.body
    );
    res.json({ milestone });
  } catch (err) {
    next(err);
  }
});

// Progress
router.get('/progress', requireAuth, async (req, res, next) => {
  try {
    const progress = await ws.calculateProgress(req.params.id, req.user.id);
    res.json({ progress });
  } catch (err) {
    next(err);
  }
});

// Activity
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const activity = await ws.listActivity(req.params.id, req.user.id);
    res.json({ activity });
  } catch (err) {
    next(err);
  }
});

// Files
router.post('/files/upload-url', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      filename: z.string().min(1).max(255),
      mime_type: z.string().optional(),
      size_bytes: z.number().int().positive().optional(),
      file_kind: z.string().optional(),
    });
    const payload = schema.parse(req.body);
    const result = await ws.getUploadUrl(req.params.id, req.user.id, payload);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/files/confirm', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      storage_path: z.string().min(1),
      original_name: z.string().optional(),
      mime_type: z.string().optional().nullable(),
      size_bytes: z.number().optional().nullable(),
      file_kind: z.string().optional(),
    });
    const payload = schema.parse(req.body);
    const file = await ws.confirmUpload(req.params.id, req.user.id, payload);
    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

router.get('/files', requireAuth, async (req, res, next) => {
  try {
    const files = await ws.listFiles(req.params.id, req.user.id);
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

router.get('/files/:fileId/download', requireAuth, async (req, res, next) => {
  try {
    const result = await ws.getDownloadUrl(req.params.id, req.params.fileId, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/files/:fileId', requireAuth, async (req, res, next) => {
  try {
    await ws.deleteFile(req.params.id, req.params.fileId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Links
router.get('/links', requireAuth, async (req, res, next) => {
  try {
    const links = await ws.listLinks(req.params.id, req.user.id);
    res.json({ links });
  } catch (err) {
    next(err);
  }
});

router.post('/links', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      label: z.string().min(1).max(150),
      url: z.string().url(),
      link_type: z.enum(['github', 'demo', 'docs', 'design', 'video', 'other']).optional(),
    });
    const payload = schema.parse(req.body);
    const link = await ws.createLink(req.params.id, req.user.id, payload);
    res.status(201).json({ link });
  } catch (err) {
    next(err);
  }
});

export default router;
