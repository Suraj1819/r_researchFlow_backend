// server/src/routes/supervision.js

import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

const facultyRoles = ['faculty', 'reviewer', 'coordinator', 'admin'];

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const fail = (res, status, message, code = 'REQUEST_ERROR') =>
  res.status(status).json({
    error: {
      code,
      message,
    },
  });

const isFaculty = (req) => facultyRoles.includes(req.profile?.role);
const isStudent = (req) => req.profile?.role === 'student';

const profileFields =
  'id, full_name, role, registration_number, roll_number, avatar_url';

const isValidId = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

async function getMeeting(meetingId) {
  const { data, error } = await supabaseAdmin
    .from('supervision_meetings')
    .select('*')
    .eq('id', meetingId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function isMeetingParticipant(meetingId, userId) {
  const { data, error } = await supabaseAdmin
    .from('supervision_meeting_participants')
    .select('id')
    .eq('meeting_id', meetingId)
    .eq('student_id', userId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function canAccessMeeting(req, meeting) {
  if (!meeting) return false;

  if (req.profile?.role === 'admin') return true;

  if (isFaculty(req)) {
    return meeting.faculty_id === req.profile.id;
  }

  if (isStudent(req)) {
    return await isMeetingParticipant(meeting.id, req.profile.id);
  }

  return false;
}

async function getStudentProfiles(studentIds) {
  if (!studentIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(profileFields)
    .in('id', studentIds)
    .eq('role', 'student');

  if (error) throw error;
  return data ?? [];
}

async function getStudentProfile(studentId) {
  if (!isValidId(studentId)) return null;

  const students = await getStudentProfiles([studentId]);
  return students[0] ?? null;
}

async function validateMeetingOwnership(meetingId, req) {
  if (!meetingId) {
    return { valid: true, meeting: null };
  }

  if (!isValidId(meetingId)) {
    return {
      valid: false,
      status: 400,
      message: 'Invalid meeting ID.',
    };
  }

  const meeting = await getMeeting(meetingId);

  if (!meeting) {
    return {
      valid: false,
      status: 404,
      message: 'Meeting not found.',
    };
  }

  if (
    req.profile.role !== 'admin' &&
    meeting.faculty_id !== req.profile.id
  ) {
    return {
      valid: false,
      status: 403,
      message: 'You can only attach notes to your own meetings.',
    };
  }

  return { valid: true, meeting };
}

// GET /supervision/meetings
router.get(
  '/meetings',
  asyncHandler(async (req, res) => {
    const userId = req.profile.id;
    const role = req.profile.role;
    const { status, from, to } = req.query;

    let meetingIds = null;

    if (isStudent(req)) {
      const { data: participants, error } = await supabaseAdmin
        .from('supervision_meeting_participants')
        .select('meeting_id')
        .eq('student_id', userId);

      if (error) throw error;

      meetingIds = (participants ?? []).map((item) => item.meeting_id);

      if (!meetingIds.length) {
        return res.json({ meetings: [] });
      }
    } else if (!isFaculty(req) && role !== 'admin') {
      return fail(
        res,
        403,
        'You cannot access supervision meetings.',
        'FORBIDDEN',
      );
    }

    let query = supabaseAdmin
      .from('supervision_meetings')
      .select('*')
      .order('meeting_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (isFaculty(req)) query = query.eq('faculty_id', userId);
    if (meetingIds) query = query.in('id', meetingIds);
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('meeting_date', from);
    if (to) query = query.lte('meeting_date', to);

    const { data: meetings, error } = await query;
    if (error) throw error;

    const ids = (meetings ?? []).map((meeting) => meeting.id);
    let participants = [];

    if (ids.length) {
      const { data, error: participantsError } = await supabaseAdmin
        .from('supervision_meeting_participants')
        .select('*')
        .in('meeting_id', ids);

      if (participantsError) throw participantsError;
      participants = data ?? [];
    }

    const studentIds = [
      ...new Set(participants.map((item) => item.student_id)),
    ];

    const students = await getStudentProfiles(studentIds);
    const studentMap = new Map(
      students.map((student) => [student.id, student]),
    );

    return res.json({
      meetings: (meetings ?? []).map((meeting) => ({
        ...meeting,
        participants: participants
          .filter((item) => item.meeting_id === meeting.id)
          .map((item) => ({
            ...item,
            student: studentMap.get(item.student_id) ?? null,
          })),
      })),
    });
  }),
);

// POST /supervision/meetings
router.post(
  '/meetings',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const {
      title,
      agenda,
      meeting_date,
      start_time,
      end_time,
      meeting_mode = 'online',
      meeting_link,
      location,
      student_ids = [],
    } = req.body ?? {};

    if (
      typeof title !== 'string' ||
      !title.trim() ||
      !meeting_date ||
      !start_time ||
      !end_time
    ) {
      return fail(
        res,
        400,
        'Title, date, start time and end time are required.',
      );
    }

    if (end_time <= start_time) {
      return fail(res, 400, 'End time must be after start time.');
    }

    if (!['online', 'in_person'].includes(meeting_mode)) {
      return fail(res, 400, 'Invalid meeting mode.');
    }

    if (meeting_mode === 'online' && meeting_link) {
      try {
        const url = new URL(meeting_link);

        if (!['http:', 'https:'].includes(url.protocol)) {
          return fail(
            res,
            400,
            'Meeting link must use HTTP or HTTPS.',
          );
        }
      } catch {
        return fail(res, 400, 'Please enter a valid meeting link.');
      }
    }

    if (meeting_mode === 'in_person' && !location?.trim()) {
      return fail(
        res,
        400,
        'Enter a location for an in-person meeting.',
      );
    }

    if (!Array.isArray(student_ids)) {
      return fail(res, 400, 'student_ids must be an array.');
    }

    const uniqueStudentIds = [...new Set(student_ids)];

    if (uniqueStudentIds.some((id) => !isValidId(id))) {
      return fail(res, 400, 'One or more student IDs are invalid.');
    }

    if (uniqueStudentIds.length > 100) {
      return fail(
        res,
        400,
        'You can invite up to 100 students per meeting.',
      );
    }

    const students = await getStudentProfiles(uniqueStudentIds);

    if (students.length !== uniqueStudentIds.length) {
      return fail(
        res,
        400,
        'One or more selected student accounts are invalid.',
      );
    }

    const { data: meeting, error } = await supabaseAdmin
      .from('supervision_meetings')
      .insert({
        faculty_id: req.profile.id,
        title: title.trim(),
        agenda:
          typeof agenda === 'string' ? agenda.trim() || null : null,
        meeting_date,
        start_time,
        end_time,
        meeting_mode,
        meeting_link:
          meeting_mode === 'online' && typeof meeting_link === 'string'
            ? meeting_link.trim() || null
            : null,
        location:
          meeting_mode === 'in_person' && typeof location === 'string'
            ? location.trim()
            : null,
      })
      .select('*')
      .single();

    if (error) throw error;

    if (uniqueStudentIds.length) {
      const rows = uniqueStudentIds.map((studentId) => ({
        meeting_id: meeting.id,
        student_id: studentId,
      }));

      const { error: insertError } = await supabaseAdmin
        .from('supervision_meeting_participants')
        .insert(rows);

      if (insertError) {
        await supabaseAdmin
          .from('supervision_meetings')
          .delete()
          .eq('id', meeting.id);

        throw insertError;
      }
    }

    return res.status(201).json({ meeting });
  }),
);

// GET /supervision/meetings/:meetingId
router.get(
  '/meetings/:meetingId',
  asyncHandler(async (req, res) => {
    const meeting = await getMeeting(req.params.meetingId);

    if (!meeting) {
      return fail(res, 404, 'Meeting not found.');
    }

    if (!(await canAccessMeeting(req, meeting))) {
      return fail(
        res,
        403,
        'You cannot access this meeting.',
        'FORBIDDEN',
      );
    }

    const { data: participants, error } = await supabaseAdmin
      .from('supervision_meeting_participants')
      .select('*')
      .eq('meeting_id', meeting.id);

    if (error) throw error;

    const students = await getStudentProfiles(
      (participants ?? []).map((item) => item.student_id),
    );

    const studentMap = new Map(
      students.map((student) => [student.id, student]),
    );

    return res.json({
      meeting: {
        ...meeting,
        participants: (participants ?? []).map((item) => ({
          ...item,
          student: studentMap.get(item.student_id) ?? null,
        })),
      },
    });
  }),
);

// PATCH /supervision/meetings/:meetingId
router.patch(
  '/meetings/:meetingId',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const meeting = await getMeeting(req.params.meetingId);

    if (!meeting) {
      return fail(res, 404, 'Meeting not found.');
    }

    if (
      req.profile.role !== 'admin' &&
      meeting.faculty_id !== req.profile.id
    ) {
      return fail(
        res,
        403,
        'You can only edit your own meetings.',
        'FORBIDDEN',
      );
    }

    const allowed = [
      'title',
      'agenda',
      'meeting_date',
      'start_time',
      'end_time',
      'meeting_mode',
      'meeting_link',
      'location',
      'status',
    ];

    const updates = {};

    for (const key of allowed) {
      if (Object.hasOwn(req.body ?? {}, key)) {
        updates[key] = req.body[key];
      }
    }

    if (updates.title !== undefined) {
      if (
        typeof updates.title !== 'string' ||
        !updates.title.trim()
      ) {
        return fail(res, 400, 'Title cannot be empty.');
      }

      updates.title = updates.title.trim();
    }

    const nextStart = updates.start_time ?? meeting.start_time;
    const nextEnd = updates.end_time ?? meeting.end_time;

    if (nextEnd <= nextStart) {
      return fail(res, 400, 'End time must be after start time.');
    }

    if (
      updates.meeting_mode !== undefined &&
      !['online', 'in_person'].includes(updates.meeting_mode)
    ) {
      return fail(res, 400, 'Invalid meeting mode.');
    }

    if (
      updates.status !== undefined &&
      !['scheduled', 'completed', 'cancelled'].includes(updates.status)
    ) {
      return fail(res, 400, 'Invalid meeting status.');
    }

    if (updates.meeting_mode === 'online') {
      updates.location = null;
    }

    if (updates.meeting_mode === 'in_person') {
      updates.meeting_link = null;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('supervision_meetings')
      .update(updates)
      .eq('id', meeting.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ meeting: data });
  }),
);

// DELETE /supervision/meetings/:meetingId
router.delete(
  '/meetings/:meetingId',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const meeting = await getMeeting(req.params.meetingId);

    if (!meeting) {
      return fail(res, 404, 'Meeting not found.');
    }

    if (
      req.profile.role !== 'admin' &&
      meeting.faculty_id !== req.profile.id
    ) {
      return fail(
        res,
        403,
        'You can only cancel your own meetings.',
        'FORBIDDEN',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_meetings')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', meeting.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ meeting: data });
  }),
);

// POST /supervision/meetings/:meetingId/respond
router.post(
  '/meetings/:meetingId/respond',
  requireRole('student'),
  asyncHandler(async (req, res) => {
    const { response } = req.body ?? {};

    if (!['accepted', 'declined'].includes(response)) {
      return fail(
        res,
        400,
        'Response must be accepted or declined.',
      );
    }

    const meeting = await getMeeting(req.params.meetingId);

    if (!meeting) {
      return fail(res, 404, 'Meeting not found.');
    }

    if (meeting.status !== 'scheduled') {
      return fail(
        res,
        400,
        'This meeting is no longer accepting responses.',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_meeting_participants')
      .update({ response })
      .eq('meeting_id', meeting.id)
      .eq('student_id', req.profile.id)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return fail(
        res,
        403,
        'You are not invited to this meeting.',
        'FORBIDDEN',
      );
    }

    return res.json({ participant: data });
  }),
);

// GET /supervision/messages/conversations
router.get(
  '/messages/conversations',
  asyncHandler(async (req, res) => {
    const userId = req.profile.id;

    if (!isFaculty(req) && !isStudent(req) && req.profile.role !== 'admin') {
      return fail(
        res,
        403,
        'You cannot access messages.',
        'FORBIDDEN',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_messages')
      .select('*')
      .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const messages = data ?? [];

    const otherIds = [
      ...new Set(
        messages.map((item) =>
          item.sender_id === userId
            ? item.recipient_id
            : item.sender_id,
        ),
      ),
    ];

    let profiles = [];

    if (otherIds.length) {
      const { data: profileData, error: profilesError } =
        await supabaseAdmin
          .from('profiles')
          .select(profileFields)
          .in('id', otherIds);

      if (profilesError) throw profilesError;
      profiles = profileData ?? [];
    }

    const profileMap = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );

    const latest = new Map();

    for (const message of messages) {
      const otherId =
        message.sender_id === userId
          ? message.recipient_id
          : message.sender_id;

      if (!latest.has(otherId)) {
        latest.set(otherId, {
          user: profileMap.get(otherId) ?? {
            id: otherId,
            full_name: 'User',
          },
          last_message: message,
          unread_count: messages.filter(
            (item) =>
              item.sender_id === otherId &&
              item.recipient_id === userId &&
              !item.read_at,
          ).length,
        });
      }
    }

    return res.json({
      conversations: [...latest.values()],
    });
  }),
);

// GET /supervision/messages/:userId
router.get(
  '/messages/:userId',
  asyncHandler(async (req, res) => {
    const otherUserId = req.params.userId;
    const currentUserId = req.profile.id;

    if (otherUserId === currentUserId) {
      return fail(res, 400, 'You cannot message yourself.');
    }

    const { data: otherProfile, error: profileError } =
      await supabaseAdmin
        .from('profiles')
        .select(profileFields)
        .eq('id', otherUserId)
        .maybeSingle();

    if (profileError) throw profileError;

    if (!otherProfile) {
      return fail(res, 404, 'User not found.');
    }

    const validPair =
      (isFaculty(req) && otherProfile.role === 'student') ||
      (isStudent(req) && facultyRoles.includes(otherProfile.role)) ||
      req.profile.role === 'admin';

    if (!validPair) {
      return fail(
        res,
        403,
        'Messaging is not allowed for this user.',
        'FORBIDDEN',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_messages')
      .select('*')
      .or(
        `and(sender_id.eq.${currentUserId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${currentUserId})`,
      )
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) throw error;

    return res.json({
      messages: data ?? [],
      user: otherProfile,
    });
  }),
);

// POST /supervision/messages
router.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { recipient_id, message } = req.body ?? {};

    if (
      !isValidId(recipient_id) ||
      typeof message !== 'string' ||
      !message.trim()
    ) {
      return fail(
        res,
        400,
        'A valid recipient and message are required.',
      );
    }

    if (message.trim().length > 5000) {
      return fail(
        res,
        400,
        'Message cannot exceed 5000 characters.',
      );
    }

    if (recipient_id === req.profile.id) {
      return fail(res, 400, 'You cannot message yourself.');
    }

    const { data: recipient, error: recipientError } =
      await supabaseAdmin
        .from('profiles')
        .select(profileFields)
        .eq('id', recipient_id)
        .maybeSingle();

    if (recipientError) throw recipientError;

    if (!recipient) {
      return fail(res, 404, 'Recipient not found.');
    }

    const validPair =
      (isFaculty(req) && recipient.role === 'student') ||
      (isStudent(req) && facultyRoles.includes(recipient.role)) ||
      req.profile.role === 'admin';

    if (!validPair) {
      return fail(
        res,
        403,
        'Messaging is not allowed for this user.',
        'FORBIDDEN',
      );
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_messages')
      .insert({
        sender_id: req.profile.id,
        recipient_id,
        message: message.trim(),
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({ message: data });
  }),
);

// POST /supervision/messages/:userId/read
router.post(
  '/messages/:userId/read',
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from('supervision_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('sender_id', req.params.userId)
      .eq('recipient_id', req.profile.id)
      .is('read_at', null);

    if (error) throw error;
    return res.json({ success: true });
  }),
);

// GET /supervision/notes
router.get(
  '/notes',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    let query = supabaseAdmin
      .from('supervision_notes')
      .select('*')
      .order('created_at', { ascending: false });

    if (req.profile.role !== 'admin') {
      query = query.eq('faculty_id', req.profile.id);
    }

    if (req.query.student_id) {
      if (!isValidId(req.query.student_id)) {
        return fail(res, 400, 'Invalid student ID.');
      }

      query = query.eq('student_id', req.query.student_id);
    }

    if (req.query.project_id) {
      if (!isValidId(req.query.project_id)) {
        return fail(res, 400, 'Invalid project ID.');
      }

      query = query.eq('project_id', req.query.project_id);
    }

    const { data: notes, error } = await query;
    if (error) throw error;

    const studentIds = [
      ...new Set((notes ?? []).map((note) => note.student_id)),
    ];

    const students = await getStudentProfiles(studentIds);
    const studentMap = new Map(
      students.map((student) => [student.id, student]),
    );

    return res.json({
      notes: (notes ?? []).map((note) => ({
        ...note,
        student: studentMap.get(note.student_id) ?? null,
      })),
    });
  }),
);

// POST /supervision/notes
router.post(
  '/notes',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};

    const studentId = body.student_id;
    const summary =
      typeof body.summary === 'string'
        ? body.summary.trim()
        : '';

    console.log('[supervision] Create note payload check:', {
      hasStudentId: Boolean(studentId),
      hasSummary: Boolean(summary),
      bodyKeys: Object.keys(body),
    });

    if (!isValidId(studentId)) {
      return fail(
        res,
        400,
        'A valid student_id is required.',
        'STUDENT_ID_REQUIRED',
      );
    }

    if (!summary) {
      return fail(
        res,
        400,
        'Summary is required.',
        'SUMMARY_REQUIRED',
      );
    }

    const student = await getStudentProfile(studentId);

    if (!student) {
      return fail(
        res,
        400,
        'Selected student account is invalid.',
        'INVALID_STUDENT',
      );
    }

    const {
      meeting_id,
      project_id,
      next_steps,
      follow_up_date,
    } = body;

    const meetingValidation = await validateMeetingOwnership(
      meeting_id,
      req,
    );

    if (!meetingValidation.valid) {
      return fail(
        res,
        meetingValidation.status,
        meetingValidation.message,
      );
    }

    if (project_id && !isValidId(project_id)) {
      return fail(res, 400, 'Invalid project ID.');
    }

    const { data, error } = await supabaseAdmin
      .from('supervision_notes')
      .insert({
        faculty_id: req.profile.id,
        student_id: studentId,
        meeting_id: meeting_id || null,
        project_id: project_id || null,
        summary,
        next_steps:
          typeof next_steps === 'string'
            ? next_steps.trim() || null
            : null,
        follow_up_date: follow_up_date || null,
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.status(201).json({
      note: {
        ...data,
        student,
      },
    });
  }),
);

// PATCH /supervision/notes/:noteId
router.patch(
  '/notes/:noteId',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const { data: existing, error: lookupError } =
      await supabaseAdmin
        .from('supervision_notes')
        .select('*')
        .eq('id', req.params.noteId)
        .maybeSingle();

    if (lookupError) throw lookupError;

    if (!existing) {
      return fail(res, 404, 'Note not found.');
    }

    if (
      req.profile.role !== 'admin' &&
      existing.faculty_id !== req.profile.id
    ) {
      return fail(
        res,
        403,
        'You can only edit your own notes.',
        'FORBIDDEN',
      );
    }

    const body = req.body ?? {};
    const updates = {};

    for (const key of [
      'summary',
      'next_steps',
      'follow_up_date',
      'meeting_id',
      'project_id',
    ]) {
      if (Object.hasOwn(body, key)) {
        updates[key] = body[key];
      }
    }

    if (updates.summary !== undefined) {
      if (
        typeof updates.summary !== 'string' ||
        !updates.summary.trim()
      ) {
        return fail(res, 400, 'Summary cannot be empty.');
      }

      updates.summary = updates.summary.trim();
    }

    if (updates.next_steps !== undefined) {
      updates.next_steps =
        typeof updates.next_steps === 'string'
          ? updates.next_steps.trim() || null
          : null;
    }

    if (updates.meeting_id) {
      const meetingValidation = await validateMeetingOwnership(
        updates.meeting_id,
        req,
      );

      if (!meetingValidation.valid) {
        return fail(
          res,
          meetingValidation.status,
          meetingValidation.message,
        );
      }
    } else if (updates.meeting_id === '') {
      updates.meeting_id = null;
    }

    if (updates.project_id && !isValidId(updates.project_id)) {
      return fail(res, 400, 'Invalid project ID.');
    }

    if (updates.project_id === '') {
      updates.project_id = null;
    }

    if (updates.follow_up_date === '') {
      updates.follow_up_date = null;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('supervision_notes')
      .update(updates)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;

    return res.json({ note: data });
  }),
);

// DELETE /supervision/notes/:noteId
router.delete(
  '/notes/:noteId',
  requireRole(...facultyRoles),
  asyncHandler(async (req, res) => {
    const { data: note, error: lookupError } =
      await supabaseAdmin
        .from('supervision_notes')
        .select('id, faculty_id')
        .eq('id', req.params.noteId)
        .maybeSingle();

    if (lookupError) throw lookupError;

    if (!note) {
      return fail(res, 404, 'Note not found.');
    }

    if (
      req.profile.role !== 'admin' &&
      note.faculty_id !== req.profile.id
    ) {
      return fail(
        res,
        403,
        'You can only delete your own notes.',
        'FORBIDDEN',
      );
    }

    const { error } = await supabaseAdmin
      .from('supervision_notes')
      .delete()
      .eq('id', note.id);

    if (error) throw error;

    return res.json({ success: true });
  }),
);

export default router;