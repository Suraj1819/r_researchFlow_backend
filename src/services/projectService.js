import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

function generateProjectCode() {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `RF-${year}-${rand}`;
}

export async function createDraft(userId, payload) {
  // Ensure profile row exists (FK projects.created_by → profiles.id)
  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, registration_number, roll_number')
    .eq('id', userId)
    .maybeSingle();

  if (!existingProfile) {
    const { error: profileErr } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      full_name: 'Student',
      role: 'student',
    }, { onConflict: 'id' });
    if (profileErr) {
      console.error('[createDraft] profile', profileErr);
      throw AppError(500, 'PROFILE_MISSING', 'Your profile is not set up yet. Sign out and sign in again, or re-run Phase 1 SQL (profile insert policy).');
    }
  }

  const code = generateProjectCode();
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .insert({
      project_code: code,
      title: payload.title || 'Untitled project',
      short_description: payload.short_description || null,
      problem_statement: payload.problem_statement || null,
      objectives: payload.objectives || [],
      project_type: payload.project_type || 'major',
      ownership_mode: payload.ownership_mode || 'team',
      category_id: payload.category_id || null,
      stage: payload.stage || 'planning',
      duration_min_months: payload.duration_min_months ?? 3,
      duration_max_months: payload.duration_max_months ?? 6,
      start_date: payload.start_date || null,
      target_end_date: payload.target_end_date || null,
      visibility: payload.visibility || 'team',
      status: 'draft',
      created_by: userId,
    })
    .select()
    .single();

  if (error) {
    console.error('[createDraft]', error);
    const msg = error.message || 'Failed to create project draft';
    // Common causes surfaced clearly
    if (msg.includes('foreign key') || error.code === '23503') {
      throw AppError(500, 'CREATE_FAILED', 'Profile not found in database. Re-login or run Phase 1 SQL + profile insert policy.');
    }
    if (msg.includes('project_code') || error.code === '23505') {
      throw AppError(500, 'CREATE_FAILED', 'Project code collision — please try again.');
    }
    throw AppError(500, 'CREATE_FAILED', msg);
  }

  const { error: memberError } = await supabaseAdmin.from('project_members').insert({
    project_id: project.id,
    student_id: userId,
    team_role: 'leader',
    membership_status: 'active',
    accepted_at: new Date().toISOString(),
  });

  if (memberError) {
    console.error('[createDraft] member', memberError);
    await supabaseAdmin.from('projects').delete().eq('id', project.id);
    throw AppError(500, 'CREATE_FAILED', memberError.message || 'Failed to register project leader');
  }

  // Roster is optional at create time (table may not exist until Phase 6)
  {
    const profile = existingProfile || { full_name: 'Leader' };
    const { error: rosterErr } = await supabaseAdmin.from('project_roster').insert({
      project_id: project.id,
      full_name: profile.full_name || 'Leader',
      registration_number: profile.registration_number || null,
      roll_number: profile.roll_number || null,
      is_leader: true,
      linked_student_id: userId,
      sort_order: 0,
    });
    if (rosterErr) console.warn('[createDraft] roster optional:', rosterErr.message);
  }

  return project;
}

export async function getProjectById(projectId, userId) {
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select(`
      *,
      category:project_categories(id, name, slug),
      members:project_members(
        id, student_id, team_role, membership_status, responsibility, accepted_at,
        student:profiles!project_members_student_id_fkey(
          id, full_name, registration_number, roll_number, avatar_url, bio, github_url, linkedin_url
        )
      ),
      technologies:project_technologies(
        id, usage_status, purpose,
        technology:technologies(id, name, category)
      ),
      roster:project_roster(*)
    `)
    .eq('id', projectId)
    .single();

  if (error || !project) throw AppError(404, 'NOT_FOUND', 'Project not found');

  const isMember =
    project.created_by === userId ||
    (project.members || []).some((m) => m.student_id === userId && m.membership_status === 'active');

  if (!isMember && project.visibility !== 'public') {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    const staff = profile && ['faculty', 'reviewer', 'coordinator', 'admin'].includes(profile.role);
    const reviewable = ['submitted', 'under_review', 'changes_requested', 'approved', 'rejected'].includes(project.status);
    if (!(staff && reviewable)) {
      throw AppError(403, 'FORBIDDEN', 'You do not have access to this project');
    }
  }
  return project;
}


export async function listMyProjects(userId) {
  const { data: memberships, error: mErr } = await supabaseAdmin
    .from('project_members')
    .select('project_id')
    .eq('student_id', userId)
    .eq('membership_status', 'active');

  if (mErr) {
    console.error('[listMyProjects] memberships:', mErr);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load projects');
  }

  const projectIds = [
    ...new Set((memberships || []).map((m) => m.project_id)),
  ];

  if (projectIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('projects')
    .select(`
      id,
      project_code,
      title,
      short_description,
      project_type,
      ownership_mode,
      stage,
      status,
      visibility,
      created_by,
      created_at,
      updated_at,
      submitted_at,
      category:project_categories(id, name)
    `)
    .in('id', projectIds)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[listMyProjects] projects:', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load projects');
  }

  const projects = data || [];

  if (projects.length === 0) return [];

  const listedProjectIds = projects.map((project) => project.id);

  const { data: activeMembers, error: membersError } = await supabaseAdmin
    .from('project_members')
    .select('project_id')
    .in('project_id', listedProjectIds)
    .eq('membership_status', 'active');

  if (membersError) {
    console.error('[listMyProjects] active members:', membersError);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load project member counts');
  }

  const memberCounts = new Map();

  for (const member of activeMembers || []) {
    memberCounts.set(
      member.project_id,
      (memberCounts.get(member.project_id) || 0) + 1,
    );
  }

  return projects.map((project) => ({
    ...project,
    active_member_count: memberCounts.get(project.id) || 0,
    member_count: memberCounts.get(project.id) || 0,
    members_count: memberCounts.get(project.id) || 0,
    team_size: memberCounts.get(project.id) || 0,
  }));
}


export async function updateProject(projectId, userId, payload) {
  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role, membership_status')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .maybeSingle();
  if (!membership) throw AppError(403, 'FORBIDDEN', 'Not a project member');

  const { data: project } = await supabaseAdmin.from('projects').select('id, status').eq('id', projectId).single();
  if (!project) throw AppError(404, 'NOT_FOUND', 'Project not found');

  if (payload.start_date && payload.target_end_date) {
    if (new Date(payload.target_end_date) < new Date(payload.start_date)) {
      throw AppError(400, 'VALIDATION_ERROR', 'Completion date cannot be before start date', {
        target_end_date: 'Must be on or after start date',
      });
    }
  }

  const { data: updated, error: upErr } = await supabaseAdmin
    .from('projects')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .select()
    .single();
  if (upErr) throw AppError(500, 'UPDATE_FAILED', 'Failed to update project');
  return updated;
}

export async function saveRoster(projectId, userId, members) {
  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .single();
  if (!membership || membership.team_role !== 'leader') {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can edit the team roster');
  }
  if (!Array.isArray(members) || members.length > 4) {
    throw AppError(400, 'TEAM_SIZE_INVALID', 'Provide zero to four additional teammates.');
  }
  const seen = new Set();
  for (const member of members) {
    if (!member.full_name || member.full_name.trim().length < 2) {
      throw AppError(400, 'VALIDATION_ERROR', 'Each member needs a full name');
    }
    if (!member.registration_number || !member.registration_number.trim()) {
      throw AppError(400, 'VALIDATION_ERROR', 'Each teammate needs a registration number');
    }
    if (!member.roll_number || !member.roll_number.trim()) {
      throw AppError(400, 'VALIDATION_ERROR', 'Each teammate needs a roll number');
    }
    if (!member.responsibility || !member.responsibility.trim()) {
      throw AppError(400, 'VALIDATION_ERROR', 'Each teammate needs a role/responsibility');
    }
    const regNo = member.registration_number.trim().toLowerCase();
    if (seen.has(regNo)) throw AppError(400, 'DUPLICATE_MEMBER', 'Duplicate registration number in team roster');
    seen.add(regNo);
  }
  await supabaseAdmin.from('project_roster').delete().eq('project_id', projectId).eq('is_leader', false);
  if (members.length === 0) {
    await supabaseAdmin.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
    return [];
  }
  const rows = members.map((m, i) => ({
    project_id: projectId,
    full_name: m.full_name.trim(),
    email: m.email?.trim() || null,
    registration_number: m.registration_number.trim(),
    roll_number: m.roll_number.trim(),
    department: m.department?.trim() || null,
    academic_year: m.academic_year?.trim() || null,
    semester: m.semester?.trim() || null,
    responsibility: m.responsibility.trim(),
    is_leader: false,
    sort_order: i + 1,
  }));
  const { data, error } = await supabaseAdmin.from('project_roster').insert(rows).select();
  if (error) {
    console.error('[saveRoster]', error);
    throw AppError(500, 'SAVE_FAILED', 'Failed to save team roster');
  }
  await supabaseAdmin.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
  return data;
}

export async function joinByProjectCode(userId, projectCode) {
  const code = (projectCode || '').trim().toUpperCase();
  if (!code) throw AppError(400, 'VALIDATION_ERROR', 'Project ID is required');

  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id, project_code, title, ownership_mode, status, created_by')
    .ilike('project_code', code)
    .maybeSingle();
  if (!project) throw AppError(404, 'NOT_FOUND', 'No project found with that Project ID');

  const { data: existing } = await supabaseAdmin
    .from('project_members')
    .select('id, membership_status')
    .eq('project_id', project.id)
    .eq('student_id', userId)
    .maybeSingle();
  if (existing?.membership_status === 'active') return { project, already_member: true };

  const { count } = await supabaseAdmin
    .from('project_members')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', project.id)
    .eq('membership_status', 'active');
  if ((count || 0) >= 5) throw AppError(400, 'TEAM_FULL', 'This project already has 5 members');

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, registration_number')
    .eq('id', userId)
    .single();

  let rosterMatch = null;
  if (profile?.registration_number) {
    const { data } = await supabaseAdmin
      .from('project_roster')
      .select('id')
      .eq('project_id', project.id)
      .eq('registration_number', profile.registration_number)
      .is('linked_student_id', null)
      .maybeSingle();
    rosterMatch = data;
  }

  if (existing) {
    await supabaseAdmin.from('project_members').update({
      membership_status: 'active',
      accepted_at: new Date().toISOString(),
      removed_at: null,
    }).eq('id', existing.id);
  } else {
    const { error } = await supabaseAdmin.from('project_members').insert({
      project_id: project.id,
      student_id: userId,
      team_role: 'member',
      membership_status: 'active',
      accepted_at: new Date().toISOString(),
    });
    if (error) throw AppError(500, 'JOIN_FAILED', 'Failed to join project');
  }

  if (rosterMatch) {
    await supabaseAdmin.from('project_roster').update({ linked_student_id: userId }).eq('id', rosterMatch.id);
  }

  const { error: _notifErr } = await supabaseAdmin.from('notifications').insert({
    recipient_id: project.created_by,
    type: 'member_joined',
    title: 'Team member joined',
    message: `${profile?.full_name || 'A student'} joined your project via Project ID`,
    project_id: project.id,
  });
if (typeof _notifErr !== 'undefined' && _notifErr) console.warn('[notifications]', _notifErr.message);
if (typeof _auditErr !== 'undefined' && _auditErr) console.warn('[audit]', _auditErr.message);

  return { project, already_member: false };
}

export async function kickMember(projectId, leaderId, studentId) {
  if (leaderId === studentId) throw AppError(400, 'INVALID', 'Leader cannot remove themselves');
  const { data: leader } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', leaderId)
    .eq('membership_status', 'active')
    .single();
  if (!leader || leader.team_role !== 'leader') throw AppError(403, 'FORBIDDEN', 'Only the leader can remove members');

  const { data: target } = await supabaseAdmin
    .from('project_members')
    .select('id, team_role')
    .eq('project_id', projectId)
    .eq('student_id', studentId)
    .eq('membership_status', 'active')
    .maybeSingle();
  if (!target) throw AppError(404, 'NOT_FOUND', 'Member not found');
  if (target.team_role === 'leader') throw AppError(400, 'INVALID', 'Cannot remove the leader');

  await supabaseAdmin.from('project_members').update({
    membership_status: 'removed',
    removed_at: new Date().toISOString(),
  }).eq('id', target.id);

  await supabaseAdmin.from('project_roster').update({ linked_student_id: null })
    .eq('project_id', projectId).eq('linked_student_id', studentId);

  const { error: _notifErr } = await supabaseAdmin.from('notifications').insert({
    recipient_id: studentId,
    type: 'member_removed',
    title: 'Removed from project',
    message: 'You were removed from a project by the team leader',
    project_id: projectId,
  });
if (typeof _notifErr !== 'undefined' && _notifErr) console.warn('[notifications]', _notifErr.message);
if (typeof _auditErr !== 'undefined' && _auditErr) console.warn('[audit]', _auditErr.message);

  return { success: true };
}

export async function submitProject(projectId, userId) {
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select(`*, members:project_members(id, student_id, team_role, membership_status), roster:project_roster(*)`)
    .eq('id', projectId)
    .single();
  if (error || !project) throw AppError(404, 'NOT_FOUND', 'Project not found');

  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .single();
  if (!membership) throw AppError(403, 'FORBIDDEN', 'Not a project member');

  if (!['draft', 'awaiting_members', 'changes_requested'].includes(project.status)) {
    throw AppError(400, 'INVALID_STATE', 'Project is not in a submittable state');
  }

  const fieldErrors = {};
  if (!project.title || project.title === 'Untitled project' || project.title.length < 5) {
    fieldErrors.title = 'Provide a meaningful title (5–150 characters)';
  }
  if (!project.short_description || project.short_description.length < 30) {
    fieldErrors.short_description = 'Short description must be at least 30 characters';
  }
  if (!project.problem_statement || project.problem_statement.length < 50) {
    fieldErrors.problem_statement = 'Problem statement must be at least 50 characters';
  }
  if (!project.objectives || project.objectives.length < 1) {
    fieldErrors.objectives = 'At least one objective is required';
  }
  const rosterNonLeader = (project.roster || []).filter((r) => !r.is_leader);
  if (project.ownership_mode === 'solo' && rosterNonLeader.length > 0) {
    fieldErrors.team = 'Solo projects cannot include additional roster members.';
  }
  if (project.ownership_mode === 'team' && rosterNonLeader.length > 4) {
    fieldErrors.team = 'A team can have at most 4 additional members.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw AppError(400, 'VALIDATION_ERROR', 'Project is not ready for submission', fieldErrors);
  }

  const { data: submitted, error: subErr } = await supabaseAdmin
    .from('projects')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('status', project.status)
    .select()
    .single();
  if (subErr || !submitted) throw AppError(409, 'CONFLICT', 'Project was modified concurrently; please retry');

  const { error: _auditErr } = await supabaseAdmin.from('audit_logs').insert({
    actor_id: userId,
    action: 'project.submitted',
    entity_type: 'project',
    entity_id: projectId,
    metadata: { previous_status: project.status },
  });
if (typeof _notifErr !== 'undefined' && _notifErr) console.warn('[notifications]', _notifErr.message);
if (typeof _auditErr !== 'undefined' && _auditErr) console.warn('[audit]', _auditErr.message);

  return submitted;
}


export async function searchStudents(search, excludeIds = []) {
  const registrationNumber =
    typeof search === 'object'
      ? String(search.registrationNumber || '').trim()
      : '';

  const rollNumber =
    typeof search === 'object'
      ? String(search.rollNumber || '').trim()
      : '';

  const q =
    typeof search === 'string'
      ? search.trim()
      : String(search.q || '').trim();

  if (!registrationNumber && !rollNumber && !q) {
    return [];
  }

  let query = supabaseAdmin
    .from('profiles')
    .select(`
      id,
      full_name,
      email,
      role,
      registration_number,
      roll_number,
      academic_year,
      semester,
      department_id,
      bio,
      avatar_url,
      github_url,
      linkedin_url,
      portfolio_url,
      is_active,
      created_at,
      updated_at
    `)
    .eq('role', 'student')
    .eq('is_active', true);

  if (registrationNumber && rollNumber) {
    query = query
      .ilike('registration_number', registrationNumber)
      .ilike('roll_number', rollNumber);
  } else if (registrationNumber) {
    query = query.ilike('registration_number', registrationNumber);
  } else if (rollNumber) {
    query = query.ilike('roll_number', rollNumber);
  } else {
    query = query.or(
      `full_name.ilike.%${q}%,registration_number.ilike.%${q}%,roll_number.ilike.%${q}%`
    );
  }

  const { data, error } = await query.limit(20);

  if (error) {
  console.error('[searchStudents] Supabase error:', {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  });

  throw AppError(500, 'QUERY_FAILED', 'Failed to search student profiles');
}

  return (data || []).filter(
    (student) => !excludeIds.includes(student.id)
  );
}


export async function deleteProject(projectId, userId) {
  // 1. Check whether the project exists and belongs to this user.
  const { data: project, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('id, created_by, status')
    .eq('id', projectId)
    .maybeSingle();

  if (projectError) {
    console.error('[deleteProject] lookup:', projectError);
    throw AppError(500, 'QUERY_FAILED', 'Failed to find project');
  }

  if (!project) {
    throw AppError(404, 'NOT_FOUND', 'Project not found');
  }

  if (project.created_by !== userId) {
    throw AppError(403, 'FORBIDDEN', 'Only the project creator can delete this project');
  }

  // 2. Delete the project.
  // Related records must either be configured with ON DELETE CASCADE
  // or be handled explicitly according to your database schema.
  const { data: deletedProject, error: deleteError } = await supabaseAdmin
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('created_by', userId)
    .select('id')
    .maybeSingle();

  if (deleteError) {
    console.error('[deleteProject] delete:', deleteError);

    if (deleteError.code === '23503') {
      throw AppError(
        409,
        'PROJECT_HAS_DEPENDENCIES',
        'Project cannot be deleted because related records still exist. Configure the appropriate foreign-key cleanup or cascade rules.'
      );
    }

    throw AppError(500, 'DELETE_FAILED', 'Failed to delete project');
  }

  if (!deletedProject) {
    throw AppError(409, 'DELETE_FAILED', 'Project was not deleted');
  }

  return { success: true };
}

export async function lookupProjectByCode(projectCode) {
  const code = (projectCode || '').trim().toUpperCase();

  if (!code) {
    throw AppError(400, 'VALIDATION_ERROR', 'Project ID is required');
  }

  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select(`
      id,
      project_code,
      title,
      short_description,
      problem_statement,
      objectives,
      project_type,
      ownership_mode,
      category_id,
      stage,
      status,
      visibility,
      start_date,
      target_end_date,
      duration_min_months,
      duration_max_months,
      created_by,
      created_at,
      members:project_members(
        id,
        student_id,
        team_role,
        membership_status,
        responsibility,
        accepted_at,
        student:profiles!project_members_student_id_fkey(
          id,
          full_name,
          registration_number,
          roll_number,
          avatar_url
        )
      ),
      roster:project_roster(
        id,
        full_name,
        email,
        registration_number,
        roll_number,
        department,
        academic_year,
        semester,
        responsibility,
        is_leader,
        linked_student_id,
        sort_order
      )
    `)
    .ilike('project_code', code)
    .maybeSingle();

  if (error) {
    console.error('[lookupProjectByCode]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to look up project');
  }

  if (!project) return null;

  // Only show active project members.
  const activeMembers = (project.members || [])
    .filter((member) => member.membership_status === 'active')
    .sort((a, b) => {
      if (a.team_role === 'leader') return -1;
      if (b.team_role === 'leader') return 1;
      return 0;
    });

  // Keep the saved roster too, since some teammates may not have joined yet.
  const roster = (project.roster || [])
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  return {
    ...project,
    members: activeMembers,
    roster,
    team_size: activeMembers.length,
  };
}


