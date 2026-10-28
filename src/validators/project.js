import { z } from 'zod';

export const projectTypeEnum = z.enum([
  'mini',
  'major',
  'research',
  'personal',
  'hackathon',
  'open_source',
]);

export const ownershipModeEnum = z.enum(['solo', 'team']);
export const stageEnum = z.enum([
  'idea',
  'planning',
  'design',
  'development',
  'testing',
  'completed',
  'maintenance',
]);
export const visibilityEnum = z.enum(['private', 'team', 'faculty', 'public']);
export const statusEnum = z.enum([
  'draft',
  'awaiting_members',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
  'rejected',
  'archived',
]);

export const createDraftSchema = z.object({
  title: z.string().min(1).max(150).optional().default('Untitled project'),
  short_description: z.string().max(500).optional().nullable(),
  problem_statement: z.string().max(5000).optional().nullable(),
  objectives: z.array(z.string().min(1)).optional().default([]),
  project_type: projectTypeEnum.optional().default('major'),
  ownership_mode: ownershipModeEnum.optional().default('team'),
  category_id: z.string().uuid().optional().nullable(),
  stage: stageEnum.optional().default('planning'),
  duration_min_months: z.number().int().min(0).max(60).optional().nullable(),
  duration_max_months: z.number().int().min(0).max(60).optional().nullable(),
  start_date: z.string().optional().nullable(),
  target_end_date: z.string().optional().nullable(),
  visibility: visibilityEnum.optional().default('team'),
});

export const updateProjectSchema = z.object({
  title: z.string().min(5).max(150).optional(),
  short_description: z.string().min(30).max(500).optional().nullable(),
  problem_statement: z.string().min(50).max(5000).optional().nullable(),
  objectives: z.array(z.string().min(1)).min(1).optional(),
  project_type: projectTypeEnum.optional(),
  ownership_mode: ownershipModeEnum.optional(),
  category_id: z.string().uuid().optional().nullable(),
  stage: stageEnum.optional(),
  duration_min_months: z.number().int().min(0).max(60).optional().nullable(),
  duration_max_months: z.number().int().min(0).max(60).optional().nullable(),
  start_date: z.string().optional().nullable(),
  target_end_date: z.string().optional().nullable(),
  visibility: visibilityEnum.optional(),
  cover_image_url: z.string().url().optional().nullable().or(z.literal('')),
});

export const inviteMemberSchema = z.object({
  invitee_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  registration_number: z.string().optional(),
  message: z.string().max(500).optional().nullable(),
}).refine((d) => d.invitee_id || d.email || d.registration_number, {
  message: 'Provide invitee_id, email, or registration_number',
});

export const addTechnologySchema = z.object({
  technology_id: z.string().uuid().optional(),
  custom_name: z.string().min(1).max(100).optional(),
  category: z.string().max(100).optional(),
  usage_status: z.enum(['planned', 'in_use', 'replaced']).optional().default('planned'),
  purpose: z.string().max(500).optional().nullable(),
}).refine((d) => d.technology_id || d.custom_name, {
  message: 'Provide technology_id or custom_name',
});

export const createModuleSchema = z.object({
  title: z.string().min(2).max(150),
  description: z.string().max(2000).optional().nullable(),
  responsible_member_id: z.string().uuid().optional().nullable(),
  start_date: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed']).optional().default('todo'),
  expected_deliverables: z.string().max(1000).optional().nullable(),
});

export const createTaskSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional().nullable(),
  module_id: z.string().uuid().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed']).optional().default('todo'),
  due_date: z.string().optional().nullable(),
  estimated_effort: z.number().min(0).optional().nullable(),
});

export const createMilestoneSchema = z.object({
  title: z.string().min(2).max(150),
  description: z.string().max(1000).optional().nullable(),
  planned_date: z.string().optional().nullable(),
  status: z.enum(['pending', 'completed', 'missed']).optional().default('pending'),
});
