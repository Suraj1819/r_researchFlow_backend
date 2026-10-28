
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

const STAFF_ROLES = ['faculty', 'reviewer', 'coordinator', 'admin'];

function assertStaff(profile) {
  if (!profile || !STAFF_ROLES.includes(profile.role)) {
    throw AppError(403, 'FORBIDDEN', 'Faculty or coordinator role required');
  }
}

function canManageGroup(group, userId, profile) {
  return (
    group.created_by === userId ||
    ['coordinator', 'admin'].includes(profile?.role)
  );
}

async function getGroupForManagement(groupId, userId, profile) {
  assertStaff(profile);

  const { data: group, error } = await supabaseAdmin
    .from('submission_groups')
    .select('*')
    .eq('id', groupId)
    .maybeSingle();

  if (error) {
    console.error('[getGroupForManagement]', error);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load group');
  }

  if (!group) {
    throw AppError(404, 'NOT_FOUND', 'Group not found');
  }

  if (!canManageGroup(group, userId, profile)) {
    throw AppError(
      403,
      'FORBIDDEN',
      'Only the group creator, coordinator, or admin can manage this group'
    );
  }

  return group;
}

async function getStudentSubmission(groupId, userId) {
  const { data, error } = await supabaseAdmin
    .from('group_submissions')
    .select('*')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[getStudentSubmission]', {
      groupId,
      userId,
      error,
    });

    throw AppError(500, 'QUERY_FAILED', error.message);
  }

  return data;
}

function assertSubmissionEditable(submission) {
  if (!submission) {
    throw AppError(404, 'NOT_FOUND', 'Submission not found');
  }

  if (submission.status !== 'submitted') return;

  if (submission.resubmission_status === 'approved') return;

  if (submission.resubmission_status === 'pending') {
    throw AppError(
      409,
      'RESUBMISSION_PENDING',
      'Your resubmission request is waiting for faculty approval'
    );
  }

  throw AppError(
    403,
    'SUBMISSION_LOCKED',
    'Your submission is locked. Request faculty approval before editing it.'
  );
}

export async function createGroup(userId, profile, payload) {
  assertStaff(profile);

  const { data: group, error: groupError } = await supabaseAdmin
    .from('submission_groups')
    .insert({
      title: payload.title,
      description: payload.description || null,
      academic_year: payload.academic_year,
      semester: payload.semester || null,
      branch: payload.branch || null,
      session_year: payload.session_year || payload.academic_year,
      coordinator_name: payload.coordinator_name || profile.full_name || null,
      starts_at: payload.starts_at || null,
      submission_deadline: payload.submission_deadline || null,
      created_by: userId,
      is_published: payload.is_published !== false,
    })
    .select()
    .single();

  if (groupError) {
    console.error('[createGroup] group insert failed:', groupError);
    throw AppError(
      500,
      'CREATE_FAILED',
      groupError.message || 'Failed to create group'
    );
  }

  const year = String(payload.academic_year || '').trim();

  if (!year) return group;

  const { data: students, error: studentsError } = await supabaseAdmin
    .from('profiles')
    .select('id, academic_year')
    .eq('role', 'student')
    .eq('is_active', true)
    .not('academic_year', 'is', null);

  if (studentsError) {
    console.error('[createGroup] Student lookup failed:', studentsError);
    throw AppError(
      500,
      'STUDENT_LOOKUP_FAILED',
      'Group created, but students could not be loaded for notifications'
    );
  }

  const matchingStudents = (students || []).filter(
    (student) =>
      String(student.academic_year || '').trim().toLowerCase() ===
      year.toLowerCase()
  );

  if (!matchingStudents.length) return group;

  const deadline = group.submission_deadline
    ? new Date(group.submission_deadline).toLocaleDateString('en-IN')
    : 'TBA';

  const rows = matchingStudents.map((student) => ({
    recipient_id: student.id,
    type: 'submission_group',
    title: 'New project submission open',
    message: `${group.title} — deadline ${deadline}. Join from Notifications.`,
    metadata: { group_id: group.id },
  }));

  const { error: notificationError } = await supabaseAdmin
    .from('notifications')
    .insert(rows);

  if (notificationError) {
    console.error('[createGroup] Notification insert failed:', notificationError);
    throw AppError(
      500,
      'NOTIFICATION_FAILED',
      'Group was created, but notifications could not be saved'
    );
  }

  return group;
}

export async function listGroups(profile, userId) {
  const isStaff = profile && STAFF_ROLES.includes(profile.role);

  let query = supabaseAdmin
    .from('submission_groups')
    .select('*, creator:profiles!submission_groups_created_by_fkey(id, full_name)')
    .order('created_at', { ascending: false });

  if (!isStaff) query = query.eq('is_published', true);

  const { data, error } = await query;

  if (error) throw AppError(500, 'QUERY_FAILED', error.message);

  return data || [];
}

export async function getGroup(groupId, userId, profile) {
  const { data: group, error } = await supabaseAdmin
    .from('submission_groups')
    .select('*, creator:profiles!submission_groups_created_by_fkey(id, full_name)')
    .eq('id', groupId)
    .maybeSingle();

  if (error) throw AppError(500, 'QUERY_FAILED', error.message);
  if (!group) throw AppError(404, 'NOT_FOUND', 'Group not found');

  const isStaff = profile && STAFF_ROLES.includes(profile.role);

  if (!group.is_published && group.created_by !== userId && !isStaff) {
    throw AppError(403, 'FORBIDDEN', 'Group not available');
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('submission_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (membershipError) {
    throw AppError(500, 'QUERY_FAILED', membershipError.message);
  }

  if (isStaff) {
    const { data: submissions, error: submissionError } = await supabaseAdmin
      .from('group_submissions')
      .select(`
        *,
        student:profiles!group_submissions_student_id_fkey(
          id,
          full_name,
          registration_number,
          roll_number,
          avatar_url
        )
      `)
      .eq('group_id', groupId)
      .order('submitted_at', { ascending: false });

    if (submissionError) {
      throw AppError(500, 'QUERY_FAILED', submissionError.message);
    }

    return {
      group,
      joined: Boolean(membership),
      submissions: submissions || [],
    };
  }

  const { data: submission, error: submissionError } = await supabaseAdmin
    .from('group_submissions')
    .select('*')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (submissionError) {
    throw AppError(500, 'QUERY_FAILED', submissionError.message);
  }

  return {
    group,
    joined: Boolean(membership),
    submission: submission || null,
  };
}

export async function updateGroup(groupId, userId, profile, payload) {
  const existingGroup = await getGroupForManagement(
    groupId,
    userId,
    profile
  );

  const updates = {};
  const allowedFields = [
    'title',
    'description',
    'academic_year',
    'semester',
    'branch',
    'session_year',
    'coordinator_name',
    'starts_at',
    'submission_deadline',
    'is_published',
  ];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      updates[field] = payload[field];
    }
  }

  if (!Object.keys(updates).length) {
    throw AppError(400, 'INVALID_INPUT', 'No fields provided to update');
  }

  if (updates.title !== undefined) updates.title = updates.title.trim();

  if (updates.academic_year !== undefined) {
    updates.academic_year = updates.academic_year.trim();
  }

  const { data, error } = await supabaseAdmin
    .from('submission_groups')
    .update(updates)
    .eq('id', existingGroup.id)
    .select()
    .single();

  if (error) {
    console.error('[updateGroup]', error);
    throw AppError(500, 'UPDATE_FAILED', error.message);
  }

  return data;
}

export async function deleteGroup(groupId, userId, profile) {
  const group = await getGroupForManagement(groupId, userId, profile);

  const { data: submissions, error: submissionsError } = await supabaseAdmin
    .from('group_submissions')
    .select('id, ppt_path')
    .eq('group_id', group.id);

  if (submissionsError) {
    throw AppError(500, 'DELETE_FAILED', 'Could not verify group submissions');
  }

  const { error: membersError } = await supabaseAdmin
    .from('submission_group_members')
    .select('id')
    .eq('group_id', group.id)
    .limit(1);

  if (membersError) {
    throw AppError(500, 'DELETE_FAILED', 'Could not verify group members');
  }

  const pptPaths = (submissions || [])
    .map((submission) => submission.ppt_path)
    .filter(Boolean);

  if (pptPaths.length) {
    const { error: storageError } = await supabaseAdmin.storage
      .from('project-files')
      .remove(pptPaths);

    if (storageError) {
      throw AppError(500, 'DELETE_FAILED', 'Could not remove presentation files');
    }
  }

  const { error: submissionDeleteError } = await supabaseAdmin
    .from('group_submissions')
    .delete()
    .eq('group_id', group.id);

  if (submissionDeleteError) {
    throw AppError(500, 'DELETE_FAILED', submissionDeleteError.message);
  }

  const { error: memberDeleteError } = await supabaseAdmin
    .from('submission_group_members')
    .delete()
    .eq('group_id', group.id);

  if (memberDeleteError) {
    throw AppError(500, 'DELETE_FAILED', memberDeleteError.message);
  }

  const { data: notifications, error: notificationLookupError } =
    await supabaseAdmin
      .from('notifications')
      .select('id, metadata')
      .eq('type', 'submission_group');

  if (notificationLookupError) {
    throw AppError(500, 'DELETE_FAILED', notificationLookupError.message);
  }

  const notificationIds = (notifications || [])
    .filter((item) => item.metadata?.group_id === group.id)
    .map((item) => item.id);

  if (notificationIds.length) {
    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .in('id', notificationIds);

    if (error) throw AppError(500, 'DELETE_FAILED', error.message);
  }

  const { error: groupDeleteError } = await supabaseAdmin
    .from('submission_groups')
    .delete()
    .eq('id', group.id);

  if (groupDeleteError) {
    throw AppError(500, 'DELETE_FAILED', groupDeleteError.message);
  }

  return { success: true, id: group.id };
}

export async function joinGroup(groupId, userId) {
  const { data: group, error: groupError } = await supabaseAdmin
    .from('submission_groups')
    .select('id, is_published')
    .eq('id', groupId)
    .maybeSingle();

  if (groupError) {
    throw AppError(500, 'QUERY_FAILED', groupError.message);
  }

  if (!group || !group.is_published) {
    throw AppError(404, 'NOT_FOUND', 'Group not found');
  }

  const { error: membershipError } = await supabaseAdmin
    .from('submission_group_members')
    .upsert(
      { group_id: groupId, student_id: userId },
      { onConflict: 'group_id,student_id' }
    );

  if (membershipError) {
    console.error('[joinGroup] Membership error:', membershipError);
    throw AppError(500, 'JOIN_FAILED', membershipError.message);
  }

  const { error: submissionError } = await supabaseAdmin
    .from('group_submissions')
    .upsert(
      {
        group_id: groupId,
        student_id: userId,
        team_name: 'My Team',
        project_title: 'Untitled project',
        status: 'draft',
      },
      {
        onConflict: 'group_id,student_id',
        ignoreDuplicates: true,
      }
    );

  if (submissionError) {
    console.error('[joinGroup] Submission error:', submissionError);
    throw AppError(500, 'JOIN_FAILED', submissionError.message);
  }

  return { success: true, joined: true };
}

export async function saveSubmission(groupId, userId, payload) {
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('submission_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (membershipError) {
    throw AppError(500, 'QUERY_FAILED', membershipError.message);
  }

  if (!membership) throw AppError(403, 'FORBIDDEN', 'Join the group first');

  const submission = await getStudentSubmission(groupId, userId);

  if (!submission) {
    throw AppError(404, 'NOT_FOUND', 'Submission not found. Rejoin the group.');
  }

  assertSubmissionEditable(submission);

  if (payload.submit && !submission.ppt_path) {
    throw AppError(
      400,
      'PRESENTATION_REQUIRED',
      'Upload your presentation before submitting'
    );
  }

  const updates = {
    team_name: payload.team_name,
    member_names: payload.member_names || [],
    project_title: payload.project_title,
    project_summary: payload.project_summary || null,
    project_id: payload.project_id || null,
    github_url: payload.github_url || null,
    linkedin_url: payload.linkedin_url || null,
    demo_url: payload.demo_url || null,
    phone: payload.phone || null,
    extra_links: payload.extra_links || [],
    updated_at: new Date().toISOString(),
  };

  if (payload.submit) {
    updates.status = 'submitted';
    updates.submitted_at = new Date().toISOString();

    if (submission.resubmission_status === 'approved') {
      updates.resubmission_status = 'none';
      updates.resubmission_reason = null;
      updates.resubmission_requested_at = null;
      updates.resubmission_reviewed_by = null;
      updates.resubmission_reviewed_at = null;
      updates.resubmission_feedback = null;
    }
  }

  let query = supabaseAdmin
    .from('group_submissions')
    .update(updates)
    .eq('id', submission.id);

  if (submission.status === 'submitted') {
    query = query.eq('resubmission_status', 'approved');
  } else {
    query = query.eq('status', 'draft');
  }

  const { data, error } = await query.select().maybeSingle();

  if (error) throw AppError(500, 'UPDATE_FAILED', error.message);

  if (!data) {
    throw AppError(
      409,
      'SUBMISSION_LOCKED',
      'Submission state changed. Refresh the page and try again.'
    );
  }

  return data;
}

export async function uploadPpt(groupId, userId, file) {
  if (!file) {
    throw AppError(400, 'INVALID_FILE', 'Choose a presentation file');
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('submission_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (membershipError) {
    console.error('[uploadPpt] Membership lookup failed:', membershipError);
    throw AppError(500, 'QUERY_FAILED', membershipError.message);
  }

  if (!membership) {
    throw AppError(
      403,
      'FORBIDDEN',
      'Membership record not found. Please leave and rejoin the group.'
    );
  }

  let submission = await getStudentSubmission(groupId, userId);

  if (!submission) {
    const { error: createError } = await supabaseAdmin
      .from('group_submissions')
      .upsert(
        {
          group_id: groupId,
          student_id: userId,
          team_name: 'My Team',
          project_title: 'Untitled project',
          status: 'draft',
        },
        {
          onConflict: 'group_id,student_id',
          ignoreDuplicates: true,
        }
      );

    if (createError) {
      console.error('[uploadPpt] Submission creation failed:', createError);
      throw AppError(500, 'SUBMISSION_CREATE_FAILED', createError.message);
    }

    submission = await getStudentSubmission(groupId, userId);
  }

  if (!submission) {
    throw AppError(
      500,
      'SUBMISSION_NOT_FOUND',
      'Could not create your submission record. Please contact the administrator.'
    );
  }

  assertSubmissionEditable(submission);

  const ext = (file.originalname || '')
    .split('.')
    .pop()
    .toLowerCase();

  const allowedMimeTypes = {
    pdf: ['application/pdf', 'application/octet-stream'],
    ppt: ['application/vnd.ms-powerpoint', 'application/octet-stream'],
    pptx: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/octet-stream',
    ],
  };

  if (!['ppt', 'pptx', 'pdf'].includes(ext)) {
    throw AppError(
      400,
      'INVALID_FILE',
      'Only PPT, PPTX or PDF files are allowed'
    );
  }

  if (file.mimetype && !allowedMimeTypes[ext].includes(file.mimetype)) {
    throw AppError(
      400,
      'INVALID_FILE',
      'The selected file type does not match its extension'
    );
  }

  const path = `${groupId}/${userId}/presentation.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from('project-files')
    .upload(path, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: true,
    });

  if (uploadError) {
    console.error('[uploadPpt] Storage upload failed:', uploadError);
    throw AppError(500, 'UPLOAD_FAILED', uploadError.message);
  }

  const { data, error: updateError } = await supabaseAdmin
    .from('group_submissions')
    .update({
      ppt_path: path,
      ppt_name: file.originalname,
      ppt_mime: file.mimetype || 'application/octet-stream',
      ppt_size: file.size,
      updated_at: new Date().toISOString(),
    })
    .eq('id', submission.id)
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .select()
    .single();

  if (updateError) {
    console.error('[uploadPpt] Submission update failed:', updateError);
    throw AppError(500, 'UPDATE_FAILED', updateError.message);
  }

  return data;
}

export async function requestResubmission(groupId, userId, reason) {
  const cleanReason = String(reason || '').trim();

  if (cleanReason.length < 10) {
    throw AppError(
      400,
      'INVALID_REASON',
      'Please explain why resubmission is needed (at least 10 characters)'
    );
  }

  if (cleanReason.length > 2000) {
    throw AppError(400, 'INVALID_REASON', 'Reason cannot exceed 2000 characters');
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('submission_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('student_id', userId)
    .maybeSingle();

  if (membershipError) {
    throw AppError(500, 'QUERY_FAILED', membershipError.message);
  }

  if (!membership) throw AppError(403, 'FORBIDDEN', 'Join the group first');

  const submission = await getStudentSubmission(groupId, userId);

  if (!submission) {
    throw AppError(404, 'NOT_FOUND', 'Submission not found');
  }

  if (submission.status !== 'submitted') {
    throw AppError(
      409,
      'INVALID_STATE',
      'Submit your project before requesting resubmission'
    );
  }

  if (submission.resubmission_status === 'pending') {
    throw AppError(409, 'REQUEST_PENDING', 'A resubmission request is already pending');
  }

  if (submission.resubmission_status === 'approved') {
    throw AppError(409, 'ALREADY_APPROVED', 'Resubmission is already approved. You can edit now.');
  }

  const { data, error } = await supabaseAdmin
    .from('group_submissions')
    .update({
      resubmission_status: 'pending',
      resubmission_reason: cleanReason,
      resubmission_requested_at: new Date().toISOString(),
      resubmission_reviewed_by: null,
      resubmission_reviewed_at: null,
      resubmission_feedback: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', submission.id)
    .eq('status', 'submitted')
    .neq('resubmission_status', 'approved')
    .select()
    .maybeSingle();

  if (error) throw AppError(500, 'UPDATE_FAILED', error.message);

  if (!data) {
    throw AppError(409, 'INVALID_STATE', 'Submission changed. Refresh and try again.');
  }

  return data;
}

export async function reviewResubmission(
  groupId,
  submissionId,
  userId,
  profile,
  payload
) {
  await getGroupForManagement(groupId, userId, profile);

  const decision = String(payload.decision || '').trim().toLowerCase();
  const feedback = String(payload.feedback || '').trim();

  if (!['approved', 'rejected'].includes(decision)) {
    throw AppError(400, 'INVALID_DECISION', 'Decision must be approved or rejected');
  }

  if (decision === 'rejected' && !feedback) {
    throw AppError(400, 'FEEDBACK_REQUIRED', 'Feedback is required when rejecting a request');
  }

  if (feedback.length > 2000) {
    throw AppError(400, 'INVALID_FEEDBACK', 'Feedback cannot exceed 2000 characters');
  }

  const { data: submission, error: lookupError } = await supabaseAdmin
    .from('group_submissions')
    .select('id, status, resubmission_status')
    .eq('id', submissionId)
    .eq('group_id', groupId)
    .maybeSingle();

  if (lookupError) throw AppError(500, 'QUERY_FAILED', lookupError.message);
  if (!submission) throw AppError(404, 'NOT_FOUND', 'Submission not found');

  if (
    submission.status !== 'submitted' ||
    submission.resubmission_status !== 'pending'
  ) {
    throw AppError(409, 'INVALID_STATE', 'There is no pending resubmission request to review');
  }

  const { data, error } = await supabaseAdmin
    .from('group_submissions')
    .update({
      resubmission_status: decision,
      resubmission_reviewed_by: userId,
      resubmission_reviewed_at: new Date().toISOString(),
      resubmission_feedback: feedback || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', submissionId)
    .eq('group_id', groupId)
    .eq('resubmission_status', 'pending')
    .select()
    .maybeSingle();

  if (error) throw AppError(500, 'UPDATE_FAILED', error.message);

  if (!data) {
    throw AppError(409, 'INVALID_STATE', 'Request was already reviewed. Refresh the page.');
  }

  return data;
}

export async function getPptUrl(groupId, submissionId, profile) {
  assertStaff(profile);

  const { data: submission, error: lookupError } = await supabaseAdmin
    .from('group_submissions')
    .select('*')
    .eq('id', submissionId)
    .eq('group_id', groupId)
    .maybeSingle();

  if (lookupError) throw AppError(500, 'QUERY_FAILED', lookupError.message);

  if (!submission?.ppt_path) {
    throw AppError(404, 'NOT_FOUND', 'No PPT uploaded');
  }

  const { data, error } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(submission.ppt_path, 60 * 15);

  if (error) throw AppError(500, 'SIGN_FAILED', error.message);

  return {
    url: data.signedUrl,
    filename: submission.ppt_name,
  };
}

// Delete an uploaded presentation
export async function deletePpt(groupId, submissionId, userId, profile) {
  const isStaff = profile && STAFF_ROLES.includes(profile.role);

  const { data: submission, error: lookupError } = await supabaseAdmin
    .from('group_submissions')
    .select('*')
    .eq('id', submissionId)
    .eq('group_id', groupId)
    .maybeSingle();

  if (lookupError) {
    console.error('[deletePpt] Submission lookup failed:', lookupError);
    throw AppError(500, 'QUERY_FAILED', 'Failed to load submission');
  }

  if (!submission) {
    throw AppError(404, 'NOT_FOUND', 'Submission not found');
  }

  if (isStaff) {
    await getGroupForManagement(groupId, userId, profile);
  } else {
    if (submission.student_id !== userId) {
      throw AppError(
        403,
        'FORBIDDEN',
        'You can delete only your own presentation'
      );
    }

    const { data: membership, error: membershipError } =
      await supabaseAdmin
        .from('submission_group_members')
        .select('id')
        .eq('group_id', groupId)
        .eq('student_id', userId)
        .maybeSingle();

    if (membershipError) {
      throw AppError(500, 'QUERY_FAILED', membershipError.message);
    }

    if (!membership) {
      throw AppError(403, 'FORBIDDEN', 'Join the group first');
    }

    assertSubmissionEditable(submission);
  }

  if (!submission.ppt_path) {
    throw AppError(404, 'NOT_FOUND', 'No presentation is uploaded');
  }

  const { error: storageError } = await supabaseAdmin.storage
    .from('project-files')
    .remove([submission.ppt_path]);

  if (storageError) {
    console.error('[deletePpt] Storage deletion failed:', storageError);
    throw AppError(
      500,
      'DELETE_FAILED',
      'Could not delete the presentation file'
    );
  }

  const { data: updatedSubmission, error: updateError } =
    await supabaseAdmin
      .from('group_submissions')
      .update({
        ppt_path: null,
        ppt_name: null,
        ppt_mime: null,
        ppt_size: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', submission.id)
      .eq('group_id', groupId)
      .select()
      .maybeSingle();

  if (updateError || !updatedSubmission) {
    console.error('[deletePpt] Database update failed:', updateError);

    throw AppError(
      500,
      'UPDATE_FAILED',
      'File was removed, but the submission record could not be updated. Contact the administrator.'
    );
  }

  return {
    success: true,
    submission: updatedSubmission,
  };
}
