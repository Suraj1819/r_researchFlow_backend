
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

const FACULTY_ROLES = ['faculty', 'reviewer', 'coordinator', 'admin'];
const ADMIN_ROLES = ['coordinator', 'admin'];

const REVIEWABLE_STATUSES = [
  'submitted',
  'under_review',
  'changes_requested',
];

function assertFaculty(profile) {
  if (!profile || !FACULTY_ROLES.includes(profile.role)) {
    throw AppError(403, 'FORBIDDEN', 'Faculty access required');
  }
}

function assertAdmin(profile) {
  if (!profile || !ADMIN_ROLES.includes(profile.role)) {
    throw AppError(403, 'FORBIDDEN', 'Administrator access required');
  }
}

function throwQueryError(error, code, message) {
  if (error) {
    console.error(`[reviewService:${code}]`, error);
    throw AppError(500, code, message);
  }
}

async function getProjectForReview(projectId) {
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select('id, status, created_by, current_revision')
    .eq('id', projectId)
    .maybeSingle();

  throwQueryError(error, 'QUERY_FAILED', 'Failed to load project');

  if (!project) {
    throw AppError(404, 'NOT_FOUND', 'Project not found');
  }

  return project;
}

export async function getReviewQueue(profile, { status, reviewerId } = {}) {
  assertFaculty(profile);

  if (status && !REVIEWABLE_STATUSES.includes(status)) {
    throw AppError(400, 'VALIDATION_ERROR', 'Invalid review queue status');
  }

  let query = supabaseAdmin
    .from('projects')
    .select(`
      id,
      project_code,
      title,
      short_description,
      project_type,
      status,
      submitted_at,
      current_revision,
      created_by,
      creator:profiles!projects_created_by_fkey(id, full_name),
      category:project_categories(id, name)
    `)
    .in('status', status ? [status] : REVIEWABLE_STATUSES)
    .order('submitted_at', { ascending: true });

  if (reviewerId) {
    query = query.neq('created_by', reviewerId);
  }

  const { data, error } = await query;

  throwQueryError(error, 'QUERY_FAILED', 'Failed to load review queue');

  return data || [];
}

export async function getProjectReviews(projectId, userId, profile) {
  const isFaculty = profile && FACULTY_ROLES.includes(profile.role);

  if (!isFaculty) {
    const { data: member, error: memberError } = await supabaseAdmin
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('student_id', userId)
      .eq('membership_status', 'active')
      .maybeSingle();

    throwQueryError(
      memberError,
      'QUERY_FAILED',
      'Failed to verify project membership',
    );

    if (!member) {
      throw AppError(403, 'FORBIDDEN', 'Access denied');
    }
  }

  const { data, error } = await supabaseAdmin
    .from('project_reviews')
    .select(`
      *,
      reviewer:profiles!project_reviews_reviewer_id_fkey(id, full_name),
      rubric:review_rubrics(id, name, criteria)
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  throwQueryError(error, 'QUERY_FAILED', 'Failed to load reviews');

  return data || [];
}

export async function submitReview(projectId, reviewerId, profile, payload) {
  assertFaculty(profile);

  const project = await getProjectForReview(projectId);

  if (project.created_by === reviewerId) {
    throw AppError(403, 'FORBIDDEN', 'You cannot review your own project');
  }

  if (!REVIEWABLE_STATUSES.includes(project.status)) {
    throw AppError(400, 'INVALID_STATE', 'Project is not under review');
  }

  const decision = payload.decision;

  if (!['changes_requested', 'approved', 'rejected'].includes(decision)) {
    throw AppError(400, 'VALIDATION_ERROR', 'Invalid decision');
  }

  const overallComment = payload.overall_comment?.trim() || null;
  const requestedChanges = payload.requested_changes?.trim() || null;

  if (decision === 'changes_requested' && !requestedChanges) {
    throw AppError(
      400,
      'VALIDATION_ERROR',
      'Please specify the changes required',
    );
  }

  if (
    (overallComment && overallComment.length > 5000) ||
    (requestedChanges && requestedChanges.length > 5000)
  ) {
    throw AppError(
      400,
      'VALIDATION_ERROR',
      'Review feedback must not exceed 5000 characters',
    );
  }

  const scores = payload.scores || {};

  for (const [key, value] of Object.entries(scores)) {
    if (
      !key.trim() ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw AppError(400, 'VALIDATION_ERROR', 'Invalid rubric scores');
    }
  }

  if (payload.rubric_id) {
    const { data: rubric, error: rubricError } = await supabaseAdmin
      .from('review_rubrics')
      .select('id, criteria')
      .eq('id', payload.rubric_id)
      .eq('is_active', true)
      .maybeSingle();

    throwQueryError(
      rubricError,
      'QUERY_FAILED',
      'Failed to validate review rubric',
    );

    if (!rubric) {
      throw AppError(
        400,
        'VALIDATION_ERROR',
        'The selected rubric is unavailable',
      );
    }

    const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];

    for (const criterion of criteria) {
      const key = criterion?.key;
      const maxScore = Number(criterion?.max_score);

      if (!key || !Number.isFinite(maxScore) || maxScore < 0) {
        throw AppError(
          400,
          'INVALID_RUBRIC',
          'The configured rubric contains invalid criteria',
        );
      }

      if (
        !Object.prototype.hasOwnProperty.call(scores, key) ||
        !Number.isFinite(scores[key]) ||
        scores[key] < 0 ||
        scores[key] > maxScore
      ) {
        throw AppError(
          400,
          'VALIDATION_ERROR',
          `A valid score is required for "${criterion.label || key}"`,
        );
      }
    }

    const validKeys = new Set(criteria.map((criterion) => criterion.key));

    if (Object.keys(scores).some((key) => !validKeys.has(key))) {
      throw AppError(
        400,
        'VALIDATION_ERROR',
        'Scores contain criteria that do not belong to this rubric',
      );
    }
  }

  const { data: review, error: reviewError } = await supabaseAdmin
    .from('project_reviews')
    .insert({
      project_id: projectId,
      reviewer_id: reviewerId,
      revision: project.current_revision || 1,
      decision,
      overall_comment: overallComment,
      rubric_id: payload.rubric_id || null,
      scores,
      requested_changes:
        decision === 'changes_requested' ? requestedChanges : null,
    })
    .select()
    .single();

  if (reviewError) {
    console.error('[submitReview]', reviewError);
    throw AppError(500, 'CREATE_FAILED', 'Failed to save review');
  }

  const newStatus =
    decision === 'approved'
      ? 'approved'
      : decision === 'rejected'
        ? 'rejected'
        : 'changes_requested';

  const { data: updatedProject, error: statusError } = await supabaseAdmin
    .from('projects')
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
    .in('status', REVIEWABLE_STATUSES)
    .select('id')
    .maybeSingle();

  if (statusError || !updatedProject) {
    console.error('[submitReview:status]', statusError);

    throw AppError(
      500,
      'UPDATE_FAILED',
      'Review was saved, but the project status could not be updated. Refresh and verify the project before retrying.',
    );
  }

  // Notify the project creator and every active team member.
  const { data: members, error: membersError } = await supabaseAdmin
    .from('project_members')
    .select('student_id')
    .eq('project_id', projectId)
    .eq('membership_status', 'active');

  if (membersError) {
    console.error('[submitReview:members]', membersError);
  } else {
    const recipientIds = [
      ...new Set([
        project.created_by,
        ...(members || []).map((member) => member.student_id),
      ]),
    ].filter(Boolean);

    const notificationTitle =
      decision === 'approved'
        ? 'Project approved'
        : decision === 'rejected'
          ? 'Project rejected'
          : 'Changes requested';

    const fallbackMessage =
      decision === 'approved'
        ? 'Your project has been approved by faculty.'
        : decision === 'rejected'
          ? 'Faculty has rejected your project. Open the review for details.'
          : `Faculty has requested changes to your project. ${requestedChanges || 'Check the review comments.'}`;

    const notificationMessage = [overallComment, requestedChanges]
      .filter(Boolean)
      .join('\n\n') || fallbackMessage;

    const notificationRows = recipientIds.map((recipientId) => ({
      recipient_id: recipientId,
      type: `review_${decision}`,
      title: notificationTitle,
      message: notificationMessage,
      project_id: projectId,
      metadata: {
        review_id: review.id,
        decision,
        revision: project.current_revision || 1,
      },
    }));

    if (notificationRows.length > 0) {
      const { error: notificationError } = await supabaseAdmin
        .from('notifications')
        .insert(notificationRows);

      if (notificationError) {
        console.error(
          '[submitReview:notifications]',
          notificationError,
        );
      }
    }
  }

  const { error: auditError } = await supabaseAdmin
    .from('audit_logs')
    .insert({
      actor_id: reviewerId,
      action: `review.${decision}`,
      entity_type: 'project',
      entity_id: projectId,
      metadata: {
        review_id: review.id,
      },
    });

  if (auditError) {
    console.warn('[submitReview:audit]', auditError.message);
  }

  return review;
}

export async function resubmitProject(projectId, userId) {
  const project = await getProjectForReview(projectId);

  if (project.created_by !== userId) {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can resubmit');
  }

  if (project.status !== 'changes_requested') {
    throw AppError(
      400,
      'INVALID_STATE',
      'Project is not in changes_requested state',
    );
  }

  const nextRevision = (project.current_revision || 1) + 1;

  const { error: revisionError } = await supabaseAdmin
    .from('project_revisions')
    .insert({
      project_id: projectId,
      revision_number: nextRevision,
      submitted_by: userId,
      notes: 'Resubmission after changes requested',
    });

  throwQueryError(
    revisionError,
    'CREATE_FAILED',
    'Failed to create project revision',
  );

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('projects')
    .update({
      status: 'submitted',
      current_revision: nextRevision,
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
    .eq('status', 'changes_requested')
    .select()
    .maybeSingle();

  throwQueryError(
    updateError,
    'UPDATE_FAILED',
    'Failed to resubmit project',
  );

  if (!updated) {
    throw AppError(
      409,
      'INVALID_STATE',
      'Project status changed before resubmission. Refresh and try again.',
    );
  }

  const { error: auditError } = await supabaseAdmin
    .from('audit_logs')
    .insert({
      actor_id: userId,
      action: 'project.resubmitted',
      entity_type: 'project',
      entity_id: projectId,
      metadata: {
        revision: nextRevision,
      },
    });

  if (auditError) {
    console.warn('[resubmitProject:audit]', auditError.message);
  }

  return updated;
}

export async function listRubrics() {
  const { data, error } = await supabaseAdmin
    .from('review_rubrics')
    .select('*')
    .eq('is_active', true)
    .order('is_default', { ascending: false });

  throwQueryError(
    error,
    'QUERY_FAILED',
    'Failed to load review rubrics',
  );

  return data || [];
}

// ─── Ideas ─────────────────────────────────────────────────

export async function listIdeas({ publishedOnly = true } = {}) {
  let query = supabaseAdmin
    .from('project_ideas')
    .select('*, category:project_categories(id, name)')
    .order('created_at', { ascending: false });

  if (publishedOnly) {
    query = query.eq('is_published', true);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[listIdeas]', error);
    return [];
  }

  return data || [];
}

export async function getIdea(id) {
  const { data, error } = await supabaseAdmin
    .from('project_ideas')
    .select('*, category:project_categories(id, name)')
    .eq('id', id)
    .maybeSingle();

  throwQueryError(error, 'QUERY_FAILED', 'Failed to load project idea');

  if (!data) {
    throw AppError(404, 'NOT_FOUND', 'Idea not found');
  }

  return data;
}

export async function createIdea(authorId, profile, payload) {
  assertFaculty(profile);

  const { data, error } = await supabaseAdmin
    .from('project_ideas')
    .insert({
      title: payload.title,
      problem_statement: payload.problem_statement || null,
      description: payload.description || null,
      suggested_features: payload.suggested_features || [],
      recommended_technologies: payload.recommended_technologies || [],
      difficulty: payload.difficulty || 'medium',
      estimated_duration: payload.estimated_duration || null,
      expected_outcome: payload.expected_outcome || null,
      category_id: payload.category_id || null,
      author_id: authorId,
      is_published: payload.is_published ?? false,
    })
    .select()
    .single();

  throwQueryError(error, 'CREATE_FAILED', 'Failed to create project idea');

  return data;
}

export async function useIdeaAsDraft(ideaId, userId) {
  const idea = await getIdea(ideaId);

  if (!idea.is_published) {
    throw AppError(404, 'NOT_FOUND', 'Idea not found');
  }

  const code = `RF-${new Date().getFullYear()}-${Math.random()
    .toString(36)
    .substring(2, 6)
    .toUpperCase()}`;

  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .insert({
      project_code: code,
      title: idea.title,
      short_description:
        (idea.description || '').slice(0, 500) || idea.title,
      problem_statement: idea.problem_statement,
      objectives: idea.suggested_features || [],
      project_type: 'major',
      ownership_mode: 'team',
      category_id: idea.category_id,
      stage: 'idea',
      duration_min_months: 3,
      duration_max_months: 6,
      visibility: 'team',
      status: 'draft',
      created_by: userId,
    })
    .select()
    .single();

  throwQueryError(error, 'CREATE_FAILED', 'Failed to create draft from idea');

  const { error: memberError } = await supabaseAdmin
    .from('project_members')
    .insert({
      project_id: project.id,
      student_id: userId,
      team_role: 'leader',
      membership_status: 'active',
      accepted_at: new Date().toISOString(),
    });

  throwQueryError(
    memberError,
    'CREATE_FAILED',
    'Project was created but the project membership could not be created',
  );

  return project;
}

// ─── Admin stats ───────────────────────────────────────────

export async function getCoordinatorStats(profile) {
  assertAdmin(profile);

  const { count: total, error: totalError } = await supabaseAdmin
    .from('projects')
    .select('id', { count: 'exact', head: true });

  throwQueryError(
    totalError,
    'QUERY_FAILED',
    'Failed to load project statistics',
  );

  const statuses = [
    'draft',
    'awaiting_members',
    'submitted',
    'under_review',
    'changes_requested',
    'approved',
    'rejected',
    'archived',
  ];

  const counts = {};

  for (const status of statuses) {
    const { count, error } = await supabaseAdmin
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);

    throwQueryError(
      error,
      'QUERY_FAILED',
      `Failed to count ${status} projects`,
    );

    counts[status] = count || 0;
  }

  const { count: students, error: studentsError } = await supabaseAdmin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'student');

  throwQueryError(
    studentsError,
    'QUERY_FAILED',
    'Failed to count students',
  );

  const { count: faculty, error: facultyError } = await supabaseAdmin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .in('role', ['faculty', 'reviewer']);

  throwQueryError(
    facultyError,
    'QUERY_FAILED',
    'Failed to count faculty',
  );

  const { data: recent, error: recentError } = await supabaseAdmin
    .from('projects')
    .select(`
      id,
      project_code,
      title,
      status,
      submitted_at,
      updated_at,
      created_at,
      creator:profiles!projects_created_by_fkey(id, full_name),
      category:project_categories(id, name)
    `)
    .order('updated_at', { ascending: false })
    .limit(12);

  throwQueryError(
    recentError,
    'QUERY_FAILED',
    'Failed to load recent projects',
  );

  const { data: queue, error: queueError } = await supabaseAdmin
    .from('projects')
    .select(`
      id,
      project_code,
      title,
      status,
      submitted_at,
      creator:profiles!projects_created_by_fkey(id, full_name),
      category:project_categories(id, name)
    `)
    .in('status', REVIEWABLE_STATUSES)
    .order('submitted_at', { ascending: true })
    .limit(20);

  throwQueryError(
    queueError,
    'QUERY_FAILED',
    'Failed to load review queue',
  );

  return {
    total_projects: total || 0,
    by_status: counts,
    active:
      (counts.draft || 0) +
      (counts.awaiting_members || 0) +
      (counts.under_review || 0) +
      (counts.changes_requested || 0),
    awaiting_review:
      (counts.submitted || 0) + (counts.under_review || 0),
    students: students || 0,
    faculty: faculty || 0,
    recent_projects: recent || [],
    review_queue: queue || [],
  };
}

export async function listCategories() {
  const { data, error } = await supabaseAdmin
    .from('project_categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');

  throwQueryError(
    error,
    'QUERY_FAILED',
    'Failed to load project categories',
  );

  return data || [];
}
