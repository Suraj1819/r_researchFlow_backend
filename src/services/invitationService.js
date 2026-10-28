
import { supabaseAdmin } from '../config/supabase.js';

const TEAM_LIMIT = 5;
const INVITATION_DAYS = 14;

const LOCKED_PROJECT_STATUSES = new Set([
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'archived',
]);

const ACTIVE = 'active';
const PENDING = 'pending';

function createError(
  message,
  status = 400,
  code = 'INVITATION_ERROR',
) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function throwDatabaseError(error, message) {
  if (!error) return;

  console.error('[invitationService]', error);

  throw createError(
    message,
    error.status || 500,
    error.code || 'DATABASE_ERROR',
  );
}

function isExpired(invitation) {
  if (!invitation?.expires_at) return true;

  const expiry = new Date(invitation.expires_at).getTime();

  return !Number.isFinite(expiry) || expiry <= Date.now();
}

function getExpiryDate() {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + INVITATION_DAYS);
  return expiry.toISOString();
}

function ensureProjectUnlocked(project) {
  if (LOCKED_PROJECT_STATUSES.has(project?.status)) {
    throw createError(
      'Invitations are disabled because this project is locked.',
      409,
      'PROJECT_LOCKED',
    );
  }
}

/**
 * Synchronize the original invitation notification with the
 * actual invitation status in project_invitations.
 *
 * Notification synchronization must not undo a successful
 * invitation response if a notification update fails.
 */

async function syncInvitationNotificationStatus({
  invitationId,
  userId,
  status,
}) {
  try {
    
const { data: notifications, error: fetchError } = await supabaseAdmin
  .from('notifications')
  .select('id, metadata, recipient_id')
  .eq('type', 'invitation')
  .eq('metadata->>invitation_id', String(invitationId));

if (fetchError) {
  console.error(
    '[syncInvitationNotificationStatus] Fetch error:',
    fetchError,
  );
  return;
}

for (const notification of notifications || []) {
  if (userId && notification.recipient_id !== userId) {
    continue;
  }

  const updatedMetadata = {
    ...(notification.metadata || {}),
    invitation_status: status,
  };

  const { error: updateError } = await supabaseAdmin
    .from('notifications')
    .update({ metadata: updatedMetadata })
    .eq('id', notification.id);

  if (updateError) {
    console.error(
      '[syncInvitationNotificationStatus] Update error:',
      updateError,
    );
  }
}

  } catch (error) {
    console.error(
      '[syncInvitationNotificationStatus] Unexpected error:',
      error
    );
  }
}


async function getTeamProject(projectId) {
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select('id, title, status, ownership_mode, created_by')
    .eq('id', projectId)
    .maybeSingle();

  throwDatabaseError(error, 'Unable to load project.');

  if (!project) {
    throw createError(
      'Project not found.',
      404,
      'PROJECT_NOT_FOUND',
    );
  }

  if (project.ownership_mode !== 'team') {
    throw createError(
      'Invitations are only available for team projects.',
      400,
      'SOLO_PROJECT',
    );
  }

  ensureProjectUnlocked(project);

  return project;
}

async function requireProjectCreator(projectId, userId) {
  const project = await getTeamProject(projectId);

  if (project.created_by !== userId) {
    throw createError(
      'Only the project creator can manage team invitations.',
      403,
      'FORBIDDEN',
    );
  }

  const { data: membership, error } = await supabaseAdmin
    .from('project_members')
    .select('id, team_role, membership_status')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', ACTIVE)
    .maybeSingle();

  throwDatabaseError(
    error,
    'Unable to verify project membership.',
  );

  if (!membership || membership.team_role !== 'leader') {
    throw createError(
      'The project creator must have an active leader membership.',
      403,
      'LEADER_MEMBERSHIP_REQUIRED',
    );
  }

  return project;
}

async function resolveInvitee({
  invitee_id,
  registration_number,
}) {
  if (
    registration_number !== undefined &&
    registration_number !== null
  ) {
    const regNo = String(registration_number).trim();

    if (!regNo) {
      throw createError('Registration number cannot be empty.');
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, registration_number, role, is_active')
      .eq('registration_number', regNo)
      .eq('role', 'student')
      .eq('is_active', true)
      .maybeSingle();

    throwDatabaseError(
      error,
      'Unable to verify the registration number.',
    );

    if (!data) {
      throw createError(
        'No active student was found with that exact registration number.',
        404,
        'STUDENT_NOT_FOUND',
      );
    }

    if (invitee_id && data.id !== invitee_id) {
      throw createError(
        'The selected student does not match the registration number.',
        400,
        'STUDENT_MISMATCH',
      );
    }

    return data;
  }

  if (!invitee_id) {
    throw createError(
      'Provide an exact registration number or a selected student profile.',
    );
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, registration_number, role, is_active')
    .eq('id', invitee_id)
    .eq('role', 'student')
    .eq('is_active', true)
    .maybeSingle();

  throwDatabaseError(
    error,
    'Unable to verify the selected student.',
  );

  if (!data) {
    throw createError(
      'The selected student is inactive or does not exist.',
      404,
      'STUDENT_NOT_FOUND',
    );
  }

  return data;
}

async function getExistingMembership(projectId, studentId) {
  const { data, error } = await supabaseAdmin
    .from('project_members')
    .select('id, student_id, team_role, membership_status')
    .eq('project_id', projectId)
    .eq('student_id', studentId)
    .maybeSingle();

  throwDatabaseError(
    error,
    'Unable to check project membership.',
  );

  return data;
}

async function getExistingInvitation(projectId, inviteeId) {
  const { data, error } = await supabaseAdmin
    .from('project_invitations')
    .select(
      'id, project_id, invitee_id, invited_by, status, expires_at, message, created_at',
    )
    .eq('project_id', projectId)
    .eq('invitee_id', inviteeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  throwDatabaseError(
    error,
    'Unable to check existing invitations.',
  );

  return data;
}


async function getTeamCounts(projectId) {
  const [membersResult, invitationsResult] = await Promise.all([
    supabaseAdmin
      .from('project_members')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('membership_status', ACTIVE),

    supabaseAdmin
      .from('project_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', PENDING)
      .gt('expires_at', new Date().toISOString()),
  ]);

  throwDatabaseError(
    membersResult.error,
    'Unable to count active team members.',
  );

  throwDatabaseError(
    invitationsResult.error,
    'Unable to count pending invitations.',
  );

  return {
    activeCount: membersResult.count ?? 0,
    pendingCount: invitationsResult.count ?? 0,
  };
}


async function expireInvitation(invitationId) {
  const { data: invitation, error: fetchError } =
    await supabaseAdmin
      .from('project_invitations')
      .select('id, invitee_id')
      .eq('id', invitationId)
      .maybeSingle();

  throwDatabaseError(
    fetchError,
    'Unable to load the invitation before expiring it.',
  );

  const { error } = await supabaseAdmin
    .from('project_invitations')
    .update({
      status: 'expired',
      updated_at: new Date().toISOString(),
    })
    .eq('id', invitationId)
    .eq('status', PENDING);

  throwDatabaseError(error, 'Unable to expire the invitation.');

  if (invitation?.invitee_id) {
    await syncInvitationNotificationStatus({
      invitationId,
      userId: invitation.invitee_id,
      status: 'expired',
    });
  }
}

async function notifyUser({
  userId,
  title,
  message,
  type = 'info',
  projectId,
  metadata = {},
}) {
  if (!userId) return;

  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .insert({
        recipient_id: userId,
        title,
        message,
        type,
        project_id: projectId || null,
        metadata,
        is_read: false,
      });

    if (error) {
      console.error('[invitation notification]', error);
    }
  } catch (error) {
    console.error('[invitation notification]', error);
  }
}

export async function createInvitation(
  projectId,
  inviterId,
  {
    invitee_id,
    registration_number,
    message = '',
  } = {},
) {
  if (!projectId || !inviterId) {
    throw createError('Project ID and inviter ID are required.');
  }

  if (!invitee_id && !registration_number) {
    throw createError(
      'Provide an exact registration number or selected student profile.',
    );
  }

  const project = await requireProjectCreator(
    projectId,
    inviterId,
  );

  const invitee = await resolveInvitee({
    invitee_id,
    registration_number,
  });

  if (invitee.id === inviterId) {
    throw createError('You cannot invite yourself.');
  }

  const existingMember = await getExistingMembership(
    projectId,
    invitee.id,
  );

  if (existingMember?.membership_status === ACTIVE) {
    throw createError(
      'This student is already an active team member.',
      409,
      'ALREADY_MEMBER',
    );
  }

  let existingInvitation = await getExistingInvitation(
    projectId,
    invitee.id,
  );

  if (
    existingInvitation?.status === PENDING &&
    isExpired(existingInvitation)
  ) {
    await expireInvitation(existingInvitation.id);

    existingInvitation = {
      ...existingInvitation,
      status: 'expired',
    };
  }

  if (
    existingInvitation?.status === PENDING &&
    !isExpired(existingInvitation)
  ) {
    throw createError(
      'A pending invitation already exists for this student.',
      409,
      'INVITATION_EXISTS',
    );
  }

  const { activeCount, pendingCount } =
    await getTeamCounts(projectId);

  if (activeCount + pendingCount >= TEAM_LIMIT) {
    throw createError(
      `The team limit is ${TEAM_LIMIT}, counting active members and pending invitations together.`,
      409,
      'TEAM_LIMIT_REACHED',
    );
  }

  const now = new Date().toISOString();

  const invitationPayload = {
    project_id: projectId,
    invitee_id: invitee.id,
    invited_by: inviterId,
    status: PENDING,
    message: String(message || '').trim() || null,
    expires_at: getExpiryDate(),
    responded_at: null,
    updated_at: now,
  };

  let invitation;
  let invitationError;

  if (existingInvitation?.id) {
    const result = await supabaseAdmin
      .from('project_invitations')
      .update(invitationPayload)
      .eq('id', existingInvitation.id)
      .select('*')
      .single();

    invitation = result.data;
    invitationError = result.error;
  } else {
    const result = await supabaseAdmin
      .from('project_invitations')
      .insert({
        ...invitationPayload,
        created_at: now,
      })
      .select('*')
      .single();

    invitation = result.data;
    invitationError = result.error;
  }

  throwDatabaseError(
    invitationError,
    'Unable to create the invitation.',
  );

  if (!invitation) {
    throw createError(
      'The invitation could not be created.',
      500,
    );
  }

  if (project.status === 'draft') {
    const { error } = await supabaseAdmin
      .from('projects')
      .update({
        status: 'awaiting_members',
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('status', 'draft');

    if (error) {
      console.error(
        '[createInvitation] project status update:',
        error,
      );
    }
  }

  await notifyUser({
    userId: invitee.id,
    title: 'Project team invitation',
    message: `You have been invited to join "${project.title}".`,
    type: 'invitation',
    projectId,
    metadata: {
      invitation_id: invitation.id,
      invitation_status: invitation.status,
    },
  });

  return {
    invitation,
    invitee: {
      id: invitee.id,
      full_name: invitee.full_name,
      registration_number: invitee.registration_number,
    },
    team: {
      activeCount,
      pendingCount: pendingCount + 1,
      limit: TEAM_LIMIT,
    },
  };
}

export async function respondToInvitation(
  invitationId,
  userId,
  accept,
) {
  if (!invitationId || !userId) {
    throw createError(
      'Invitation ID and authenticated user are required.',
    );
  }

  const { data: invitation, error } = await supabaseAdmin
    .from('project_invitations')
    .select(`
      *,
      project:projects (
        id,
        title,
        status,
        ownership_mode,
        created_by
      )
    `)
    .eq('id', invitationId)
    .maybeSingle();

  throwDatabaseError(
    error,
    'Unable to load the invitation.',
  );

  if (!invitation) {
    throw createError(
      'Invitation not found.',
      404,
      'NOT_FOUND',
    );
  }

  if (invitation.invitee_id !== userId) {
    throw createError(
      'You are not authorized to respond to this invitation.',
      403,
      'FORBIDDEN',
    );
  }

  if (invitation.status !== PENDING) {
    await syncInvitationNotificationStatus({
      invitationId: invitation.id,
      userId,
      status: invitation.status,
    });

    throw createError(
      'This invitation is no longer pending.',
      409,
      'INVITATION_NOT_PENDING',
    );
  }

  if (isExpired(invitation)) {
    await expireInvitation(invitationId);

    throw createError(
      'This invitation has expired.',
      410,
      'INVITATION_EXPIRED',
    );
  }

  const project = invitation.project;

  if (!project) {
    throw createError(
      'The associated project no longer exists.',
      404,
    );
  }

  const now = new Date().toISOString();

   if (accept) {
    if (project.ownership_mode !== 'team') {
      throw createError(
        'Invitations cannot be accepted for solo projects.',
        409,
        'SOLO_PROJECT',
      );
    }

    // Allow previously created invitations to be accepted
    // even if the project is locked.
    // New invitations remain blocked by requireProjectCreator()
    // and getTeamProject().

    const existingMember = await getExistingMembership(
      invitation.project_id,
      userId,
    );

    if (existingMember?.membership_status === ACTIVE) {
      throw createError(
        'You are already an active member of this project.',
        409,
        'ALREADY_MEMBER',
      );
    }

    const { activeCount, pendingCount } =
      await getTeamCounts(invitation.project_id);

    if (activeCount >= TEAM_LIMIT) {
      throw createError(
        'The team has reached its member limit.',
        409,
        'TEAM_LIMIT_REACHED',
      );
    }

    const membershipPayload = {
      project_id: invitation.project_id,
      student_id: userId,
      team_role: 'member',
      membership_status: ACTIVE,
      invited_by: invitation.invited_by,
      invited_at: invitation.created_at || now,
      accepted_at: now,
      removed_at: null,
      updated_at: now,
    };

    const { data: membership, error: membershipError } =
      await supabaseAdmin
        .from('project_members')
        .upsert(membershipPayload, {
          onConflict: 'project_id,student_id',
        })
        .select('*')
        .single();

    throwDatabaseError(
      membershipError,
      'Unable to activate your team membership.',
    );

    const {
      data: acceptedInvitation,
      error: acceptError,
    } = await supabaseAdmin
      .from('project_invitations')
      .update({
        status: 'accepted',
        responded_at: now,
        updated_at: now,
      })
      .eq('id', invitationId)
      .eq('invitee_id', userId)
      .eq('status', PENDING)
      .gt('expires_at', now)
      .select('*')
      .maybeSingle();

    if (acceptError || !acceptedInvitation) {
      if (existingMember) {
        await supabaseAdmin
          .from('project_members')
          .update({
            membership_status:
              existingMember.membership_status,
            removed_at:
              existingMember.membership_status === 'removed'
                ? now
                : null,
            updated_at: now,
          })
          .eq('id', existingMember.id);
      } else {
        await supabaseAdmin
          .from('project_members')
          .delete()
          .eq('project_id', invitation.project_id)
          .eq('student_id', userId)
          .eq('membership_status', ACTIVE);
      }

      throwDatabaseError(
        acceptError,
        'Unable to accept the invitation.',
      );

      throw createError(
        'The invitation changed while being accepted. Refresh and try again.',
        409,
        'INVITATION_CONFLICT',
      );
    }

    await syncInvitationNotificationStatus({
      invitationId: invitation.id,
      userId,
      status: 'accepted',
    });

    await notifyUser({
      userId: invitation.invited_by,
      title: 'Invitation accepted',
      message: `Your invitation to "${project.title}" was accepted.`,
      type: 'success',
      projectId: invitation.project_id,
      metadata: {
        invitation_id: invitation.id,
        invitation_status: 'accepted',
      },
    });

    return {
      invitation: acceptedInvitation,
      membership,
      accepted: true,
      team: {
        activeCount: activeCount + 1,
        pendingCount: Math.max(0, pendingCount - 1),
        limit: TEAM_LIMIT,
      },
    };
  }

  const {
    data: declinedInvitation,
    error: declineError,
  } = await supabaseAdmin
    .from('project_invitations')
    .update({
      status: 'declined',
      responded_at: now,
      updated_at: now,
    })
    .eq('id', invitationId)
    .eq('invitee_id', userId)
    .eq('status', PENDING)
    .gt('expires_at', now)
    .select('*')
    .maybeSingle();

  throwDatabaseError(
    declineError,
    'Unable to decline the invitation.',
  );

  if (!declinedInvitation) {
    throw createError(
      'The invitation expired or changed. Refresh and try again.',
      409,
      'INVITATION_CONFLICT',
    );
  }

  await syncInvitationNotificationStatus({
    invitationId: invitation.id,
    userId,
    status: 'declined',
  });

  await notifyUser({
    userId: invitation.invited_by,
    title: 'Invitation declined',
    message: `Your invitation to "${project.title}" was declined.`,
    type: 'info',
    projectId: invitation.project_id,
    metadata: {
      invitation_id: invitation.id,
      invitation_status: 'declined',
    },
  });

  return {
    invitation: declinedInvitation,
    accepted: false,
  };
}

export async function listMyInvitations(userId) {
  if (!userId) {
    throw createError(
      'Authenticated user is required.',
      401,
    );
  }

  const { data, error } = await supabaseAdmin
    .from('project_invitations')
    .select(`
      *,
      project:projects (
        id,
        title,
        status,
        ownership_mode,
        created_by
      ),
      inviter:profiles!project_invitations_invited_by_fkey (
        id,
        full_name
      )
    `)
    .eq('invitee_id', userId)
    .order('created_at', { ascending: false });

  throwDatabaseError(
    error,
    'Unable to load your invitations.',
  );

  const invitations = data || [];

  for (const invitation of invitations) {
    if (
      invitation.status === PENDING &&
      isExpired(invitation)
    ) {
      await expireInvitation(invitation.id);
      invitation.status = 'expired';
    }
  }

  return invitations.map((invitation) => ({
    ...invitation,
    is_expired: invitation.status === 'expired',
  }));
}

export async function listProjectInvitations(
  projectId,
  userId,
) {
  if (!projectId || !userId) {
    throw createError(
      'Project ID and authenticated user are required.',
    );
  }

  await requireProjectCreator(projectId, userId);

  const { data, error } = await supabaseAdmin
    .from('project_invitations')
    .select(`
      *,
      invitee:profiles!project_invitations_invitee_id_fkey (
        id,
        full_name,
        registration_number
      ),
      inviter:profiles!project_invitations_invited_by_fkey (
        id,
        full_name
      )
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  throwDatabaseError(
    error,
    'Unable to load project invitations.',
  );

  const invitations = data || [];

  for (const invitation of invitations) {
    if (
      invitation.status === PENDING &&
      isExpired(invitation)
    ) {
      await expireInvitation(invitation.id);
      invitation.status = 'expired';
    }
  }

  return invitations.map((invitation) => ({
    ...invitation,
    is_expired: invitation.status === 'expired',
  }));
}
