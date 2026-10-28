
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

async function assertProjectMember(
  projectId,
  userId,
  { leaderOnly = false, allowFaculty = false } = {},
) {
  const { data: membership, error } = await supabaseAdmin
    .from('project_members')
    .select('team_role, membership_status')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .maybeSingle();

  if (error) {
    console.error('[assertProjectMember]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to verify project membership');
  }

  if (membership) {
    if (leaderOnly && membership.team_role !== 'leader') {
      throw AppError(403, 'FORBIDDEN', 'Only the project leader can perform this action');
    }

    return membership;
  }

  if (allowFaculty) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      throw AppError(500, 'QUERY_FAILED', 'Failed to verify user role');
    }

    if (
      profile &&
      ['faculty', 'reviewer', 'coordinator', 'admin'].includes(profile.role)
    ) {
      return {
        team_role: 'faculty',
        membership_status: 'active',
      };
    }
  }

  throw AppError(403, 'FORBIDDEN', 'You are not an active member of this project');
}

// ─── Modules ───────────────────────────────────────────────

export async function listModules(projectId, userId) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('project_modules')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order')
    .order('created_at');

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load modules');
  }

  return data || [];
}

export async function createModule(projectId, userId, payload) {
  await assertProjectMember(projectId, userId, { leaderOnly: true });

  const { data, error } = await supabaseAdmin
    .from('project_modules')
    .insert({
      project_id: projectId,
      title: payload.title,
      description: payload.description || null,
      responsible_member_id: payload.responsible_member_id || null,
      start_date: payload.start_date || null,
      due_date: payload.due_date || null,
      status: payload.status || 'todo',
      expected_deliverables: payload.expected_deliverables || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[createModule]', error);
    throw AppError(500, 'CREATE_FAILED', 'Failed to create module');
  }

  await logActivity(projectId, userId, 'module.created', {
    module_id: data.id,
    title: data.title,
  });

  return data;
}

export async function updateModule(projectId, moduleId, userId, payload) {
  await assertProjectMember(projectId, userId, { leaderOnly: true });

  const { data, error } = await supabaseAdmin
    .from('project_modules')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', moduleId)
    .eq('project_id', projectId)
    .select()
    .single();

  if (error) {
    throw AppError(500, 'UPDATE_FAILED', 'Failed to update module');
  }

  return data;
}

// ─── Tasks ─────────────────────────────────────────────────

export async function listTasks(projectId, userId) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select(`
      *,
      assignee:profiles!tasks_assigned_to_fkey(id, full_name),
      module:project_modules(id, title)
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load tasks');
  }

  return data || [];
}

export async function createTask(projectId, userId, payload) {
  const membership = await assertProjectMember(projectId, userId);

  if (payload.assigned_to) {
    const { data: assigneeMember, error: assigneeError } = await supabaseAdmin
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('student_id', payload.assigned_to)
      .eq('membership_status', 'active')
      .maybeSingle();

    if (assigneeError) {
      throw AppError(500, 'QUERY_FAILED', 'Failed to verify task assignee');
    }

    if (!assigneeMember) {
      throw AppError(400, 'INVALID_ASSIGNEE', 'Assignee must be an active project member');
    }
  }

  if (
    payload.assigned_to &&
    payload.assigned_to !== userId &&
    membership.team_role !== 'leader'
  ) {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can assign tasks to others');
  }

  const { data, error } = await supabaseAdmin
    .from('tasks')
    .insert({
      project_id: projectId,
      module_id: payload.module_id || null,
      title: payload.title,
      description: payload.description || null,
      assigned_to: payload.assigned_to || null,
      priority: payload.priority || 'medium',
      status: payload.status || 'todo',
      due_date: payload.due_date || null,
      estimated_effort: payload.estimated_effort || null,
      created_by: userId,
    })
    .select(`
      *,
      assignee:profiles!tasks_assigned_to_fkey(id, full_name),
      module:project_modules(id, title)
    `)
    .single();

  if (error) {
    console.error('[createTask]', error);
    throw AppError(500, 'CREATE_FAILED', 'Failed to create task');
  }

  await logActivity(projectId, userId, 'task.created', {
    task_id: data.id,
    title: data.title,
  });

  const { data: members, error: membersError } = await supabaseAdmin
    .from('project_members')
    .select('student_id')
    .eq('project_id', projectId)
    .eq('membership_status', 'active');

  if (membersError) {
    console.warn('[createTask:members]', membersError.message);
  } else {
    const rows = [
      ...new Set((members || []).map((member) => member.student_id)),
    ]
      .filter((recipientId) => recipientId && recipientId !== userId)
      .map((recipientId) => ({
        recipient_id: recipientId,
        type: data.assigned_to === recipientId ? 'task_assigned' : 'task_created',
        title:
          data.assigned_to === recipientId
            ? 'Task assigned to you'
            : 'New task on project',
        message:
          data.assigned_to === recipientId
            ? `You were assigned: ${data.title}`
            : `New task added: ${data.title}`,
        project_id: projectId,
        metadata: {
          task_id: data.id,
          assigned_to: data.assigned_to,
        },
      }));

    if (rows.length) {
      const { error: notificationError } = await supabaseAdmin
        .from('notifications')
        .insert(rows);

      if (notificationError) {
        console.warn('[createTask:notifications]', notificationError.message);
      }
    }
  }

  return data;
}

export async function updateTask(projectId, taskId, userId, payload) {
  const membership = await assertProjectMember(projectId, userId);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (existingError) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load task');
  }

  if (!existing) {
    throw AppError(404, 'NOT_FOUND', 'Task not found');
  }

  if (
    membership.team_role !== 'leader' &&
    existing.assigned_to !== userId &&
    existing.created_by !== userId
  ) {
    throw AppError(403, 'FORBIDDEN', 'You can only update tasks assigned to you');
  }

  if (payload.assigned_to) {
    const { data: assignee, error: assigneeError } = await supabaseAdmin
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('student_id', payload.assigned_to)
      .eq('membership_status', 'active')
      .maybeSingle();

    if (assigneeError) {
      throw AppError(500, 'QUERY_FAILED', 'Failed to verify task assignee');
    }

    if (!assignee) {
      throw AppError(400, 'INVALID_ASSIGNEE', 'Assignee must be an active project member');
    }
  }

  const { data, error } = await supabaseAdmin
    .from('tasks')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('project_id', projectId)
    .select(`
      *,
      assignee:profiles!tasks_assigned_to_fkey(id, full_name),
      module:project_modules(id, title)
    `)
    .single();

  if (error) {
    throw AppError(500, 'UPDATE_FAILED', 'Failed to update task');
  }

  if (payload.status && payload.status !== existing.status) {
    await logActivity(projectId, userId, 'task.status_changed', {
      task_id: taskId,
      from: existing.status,
      to: payload.status,
    });
  }

  return data;
}

// ─── Milestones ────────────────────────────────────────────

export async function listMilestones(projectId, userId) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('milestones')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order')
    .order('planned_date');

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load milestones');
  }

  return data || [];
}

export async function createMilestone(projectId, userId, payload) {
  await assertProjectMember(projectId, userId, { leaderOnly: true });

  const { data, error } = await supabaseAdmin
    .from('milestones')
    .insert({
      project_id: projectId,
      title: payload.title,
      description: payload.description || null,
      planned_date: payload.planned_date || null,
      status: payload.status || 'pending',
    })
    .select()
    .single();

  if (error) {
    throw AppError(500, 'CREATE_FAILED', 'Failed to create milestone');
  }

  await logActivity(projectId, userId, 'milestone.created', {
    milestone_id: data.id,
    title: data.title,
  });

  return data;
}

export async function updateMilestone(projectId, milestoneId, userId, payload) {
  await assertProjectMember(projectId, userId, { leaderOnly: true });

  const updates = {
    ...payload,
    updated_at: new Date().toISOString(),
  };

  if (payload.status === 'completed' && !payload.completed_at) {
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('milestones')
    .update(updates)
    .eq('id', milestoneId)
    .eq('project_id', projectId)
    .select()
    .single();

  if (error) {
    throw AppError(500, 'UPDATE_FAILED', 'Failed to update milestone');
  }

  return data;
}

// ─── Progress ──────────────────────────────────────────────

export async function calculateProgress(projectId, userId) {
  await assertProjectMember(projectId, userId);

  const { data: tasks, error: tasksError } = await supabaseAdmin
    .from('tasks')
    .select('id, status, priority, due_date')
    .eq('project_id', projectId);

  if (tasksError) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to calculate task progress');
  }

  const { data: milestones, error: milestonesError } = await supabaseAdmin
    .from('milestones')
    .select('id, status, planned_date')
    .eq('project_id', projectId);

  if (milestonesError) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to calculate milestone progress');
  }

  const allTasks = tasks || [];
  const eligible = allTasks.filter((task) => task.status !== 'cancelled');
  const completed = eligible.filter((task) => task.status === 'completed');
  const blocked = eligible.filter((task) => task.status === 'blocked');

  const now = new Date();

  const overdue = eligible.filter(
    (task) =>
      task.due_date &&
      task.status !== 'completed' &&
      new Date(task.due_date) < now,
  );

  const taskProgress =
    eligible.length === 0
      ? 0
      : Math.round((completed.length / eligible.length) * 100);

  const allMilestones = milestones || [];
  const completedMilestones = allMilestones.filter(
    (milestone) => milestone.status === 'completed',
  );

  const milestoneProgress =
    allMilestones.length === 0
      ? null
      : Math.round((completedMilestones.length / allMilestones.length) * 100);

  let health = 'on_track';

  if (eligible.length > 0 && blocked.length / eligible.length > 0.3) {
    health = 'blocked';
  } else if (overdue.length > 0) {
    health = 'at_risk';
  } else if (
    eligible.length > 3 &&
    completed.length === 0
  ) {
    health = 'delayed';
  }

  if (
    eligible.length > 0 &&
    completed.length === eligible.length &&
    (allMilestones.length === 0 ||
      completedMilestones.length === allMilestones.length)
  ) {
    health = 'completed';
  }

  return {
    task_progress: taskProgress,
    milestone_progress: milestoneProgress,
    completed_tasks: completed.length,
    total_tasks: eligible.length,
    blocked_tasks: blocked.length,
    overdue_tasks: overdue.length,
    completed_milestones: completedMilestones.length,
    total_milestones: allMilestones.length,
    health,
  };
}

// ─── Activity / audit ──────────────────────────────────────

async function logActivity(projectId, actorId, action, metadata = {}) {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    actor_id: actorId,
    action,
    entity_type: 'project',
    entity_id: projectId,
    metadata,
  });

  if (error) {
    console.warn('[logActivity]', error.message);
  }
}

export async function listActivity(projectId, userId, { limit = 50 } = {}) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('audit_logs')
    .select(`
      id, action, metadata, created_at,
      actor:profiles!audit_logs_actor_id_fkey(id, full_name)
    `)
    .eq('entity_type', 'project')
    .eq('entity_id', projectId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100));

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load activity');
  }

  return data || [];
}

// ─── Files ─────────────────────────────────────────────────

export async function getUploadUrl(
  projectId,
  userId,
  { filename, mime_type, size_bytes, file_kind },
) {
  await assertProjectMember(projectId, userId);

  const maxSize = 20 * 1024 * 1024;

  if (size_bytes && size_bytes > maxSize) {
    throw AppError(400, 'FILE_TOO_LARGE', 'File exceeds 20 MB limit');
  }

  const allowed = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
    'text/csv',
    'video/mp4',
    'video/webm',
  ];

  if (mime_type && !allowed.includes(mime_type)) {
    throw AppError(400, 'INVALID_TYPE', 'File type not allowed');
  }

  const safeName = String(filename || 'upload')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);

  const storagePath = `${projectId}/${userId}/${Date.now()}_${safeName}`;

  const { data, error } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUploadUrl(storagePath);

  if (error) {
    console.error('[getUploadUrl]', error);

    return {
      storage_path: storagePath,
      signed_url: null,
      token: null,
      error: 'Storage bucket may not be configured. Create a private bucket named "project-files".',
      meta: { filename: safeName, mime_type, size_bytes, file_kind },
    };
  }

  return {
    storage_path: storagePath,
    signed_url: data.signedUrl,
    token: data.token,
    meta: { filename: safeName, mime_type, size_bytes, file_kind },
  };
}

export async function confirmUpload(
  projectId,
  userId,
  { storage_path, original_name, mime_type, size_bytes, file_kind },
) {
  await assertProjectMember(projectId, userId);

  if (!storage_path || !storage_path.startsWith(`${projectId}/${userId}/`)) {
    throw AppError(400, 'INVALID_PATH', 'Invalid storage path');
  }

  const { data, error } = await supabaseAdmin
    .from('project_files')
    .insert({
      project_id: projectId,
      uploaded_by: userId,
      original_name: original_name || storage_path.split('/').pop(),
      storage_path,
      mime_type: mime_type || null,
      size_bytes: size_bytes || null,
      file_kind: file_kind || 'other',
      visibility: 'team',
    })
    .select()
    .single();

  if (error) {
    console.error('[confirmUpload]', error);
    throw AppError(
      500,
      'CONFIRM_FAILED',
      'Failed to record file metadata. Ensure project_files table exists.',
    );
  }

  await logActivity(projectId, userId, 'file.uploaded', {
    file_id: data.id,
    name: data.original_name,
  });

  return data;
}

export async function listFiles(projectId, userId) {
  await assertProjectMember(projectId, userId, { allowFaculty: true });

  const { data, error } = await supabaseAdmin
    .from('project_files')
    .select(`
      id, original_name, mime_type, size_bytes, file_kind, visibility, version, created_at,
      uploader:profiles!project_files_uploaded_by_fkey(id, full_name)
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[listFiles]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load project files');
  }

  return data || [];
}

export async function getDownloadUrl(projectId, fileId, userId) {
  await assertProjectMember(projectId, userId, { allowFaculty: true });

  const { data: file, error } = await supabaseAdmin
    .from('project_files')
    .select('*')
    .eq('id', fileId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load file');
  }

  if (!file) {
    throw AppError(404, 'NOT_FOUND', 'File not found');
  }

  const { data, error: signError } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(file.storage_path, 60 * 10);

  if (signError) {
    throw AppError(500, 'SIGN_FAILED', 'Failed to generate download URL');
  }

  return {
    url: data.signedUrl,
    filename: file.original_name,
  };
}

export async function deleteFile(projectId, fileId, userId) {
  const membership = await assertProjectMember(projectId, userId);

  const { data: file, error } = await supabaseAdmin
    .from('project_files')
    .select('*')
    .eq('id', fileId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load file');
  }

  if (!file) {
    throw AppError(404, 'NOT_FOUND', 'File not found');
  }

  if (membership.team_role !== 'leader' && file.uploaded_by !== userId) {
    throw AppError(403, 'FORBIDDEN', 'You can only delete files you uploaded');
  }

  const { error: storageError } = await supabaseAdmin.storage
    .from('project-files')
    .remove([file.storage_path]);

  if (storageError) {
    console.warn('[deleteFile:storage]', storageError.message);
  }

  const { error: deleteError } = await supabaseAdmin
    .from('project_files')
    .delete()
    .eq('id', fileId)
    .eq('project_id', projectId);

  if (deleteError) {
    throw AppError(500, 'DELETE_FAILED', 'Failed to delete file metadata');
  }

  await logActivity(projectId, userId, 'file.deleted', {
    file_id: fileId,
    name: file.original_name,
  });

  return { success: true };
}

// ─── Links ─────────────────────────────────────────────────

export async function listLinks(projectId, userId) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('project_links')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load project links');
  }

  return data || [];
}

export async function createLink(projectId, userId, payload) {
  await assertProjectMember(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('project_links')
    .insert({
      project_id: projectId,
      label: payload.label,
      url: payload.url,
      link_type: payload.link_type || 'other',
      created_by: userId,
    })
    .select()
    .single();

  if (error) {
    throw AppError(500, 'CREATE_FAILED', 'Failed to create link');
  }

  return data;
}

// ─── My tasks ──────────────────────────────────────────────

export async function listMyTasks(userId) {
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select(`
      *,
      project:projects(id, title, project_code, status),
      assignee:profiles!tasks_assigned_to_fkey(id, full_name)
    `)
    .eq('assigned_to', userId)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[listMyTasks]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load your tasks');
  }

  return data || [];
}

// ─── Notifications ─────────────────────────────────────────


export async function listNotifications(userId, { unreadOnly = false } = {}) {
  let query = supabaseAdmin
    .from('notifications')
    .select('*')
    .eq('recipient_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[listNotifications]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load notifications');
  }

  return data || [];
}

export async function markNotificationRead(notificationId, userId) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId)
    .eq('recipient_id', userId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[markNotificationRead]', error);
    throw AppError(500, 'UPDATE_FAILED', 'Failed to update notification');
  }

  if (!data) {
    throw AppError(404, 'NOT_FOUND', 'Notification not found');
  }

  return data;
}

export async function markAllNotificationsRead(userId) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('recipient_id', userId)
    .eq('is_read', false)
    .select('id');

  if (error) {
    console.error('[markAllNotificationsRead]', error);
    throw AppError(
      500,
      'UPDATE_FAILED',
      'Failed to mark all notifications as read',
    );
  }

  return {
    success: true,
    updated: data?.length || 0,
  };
}

export async function deleteNotification(notificationId, userId) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('id', notificationId)
    .eq('recipient_id', userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[deleteNotification]', error);
    throw AppError(500, 'DELETE_FAILED', 'Failed to delete notification');
  }

  if (!data) {
    throw AppError(404, 'NOT_FOUND', 'Notification not found');
  }

  return {
    success: true,
    deleted: data.id,
  };
}


export async function deleteAllNotifications(userId) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('recipient_id', userId)
    .select('id');

  if (error) {
    console.error('[deleteAllNotifications]', error);
    throw AppError(
      500,
      'DELETE_FAILED',
      'Failed to delete notifications',
    );
  }

  return {
    success: true,
    deleted: data?.length || 0,
  };
}



