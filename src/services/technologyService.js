import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

export async function listTechnologies({ category, search } = {}) {
  let query = supabaseAdmin
    .from('technologies')
    .select('id, name, category, description, is_custom')
    .eq('is_active', true)
    .order('category')
    .order('name');

  if (category) {
    query = query.eq('category', category);
  }
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw AppError(500, 'QUERY_FAILED', 'Failed to load technologies');
  }
  return data || [];
}

export async function addProjectTechnology(projectId, userId, payload) {
  // Leader check
  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .single();

  if (!membership || membership.team_role !== 'leader') {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can manage technologies');
  }

  let technologyId = payload.technology_id;

  if (!technologyId && payload.custom_name) {
    // Create custom technology
    const { data: custom, error: cErr } = await supabaseAdmin
      .from('technologies')
      .insert({
        name: payload.custom_name,
        category: payload.category || 'Other',
        is_custom: true,
        created_by: userId,
      })
      .select()
      .single();

    if (cErr) {
      // Might already exist
      const { data: existing } = await supabaseAdmin
        .from('technologies')
        .select('id')
        .eq('name', payload.custom_name)
        .maybeSingle();
      if (existing) {
        technologyId = existing.id;
      } else {
        throw AppError(500, 'CREATE_FAILED', 'Failed to create custom technology');
      }
    } else {
      technologyId = custom.id;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('project_technologies')
    .upsert(
      {
        project_id: projectId,
        technology_id: technologyId,
        usage_status: payload.usage_status || 'planned',
        purpose: payload.purpose || null,
      },
      { onConflict: 'project_id,technology_id' }
    )
    .select(
      `
      id, usage_status, purpose,
      technology:technologies(id, name, category)
    `
    )
    .single();

  if (error) {
    console.error('[addProjectTechnology]', error);
    throw AppError(500, 'ADD_FAILED', 'Failed to add technology');
  }

  return data;
}

export async function removeProjectTechnology(projectId, technologyId, userId) {
  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .single();

  if (!membership || membership.team_role !== 'leader') {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can manage technologies');
  }

  const { error } = await supabaseAdmin
    .from('project_technologies')
    .delete()
    .eq('project_id', projectId)
    .eq('technology_id', technologyId);

  if (error) {
    throw AppError(500, 'DELETE_FAILED', 'Failed to remove technology');
  }

  return { success: true };
}

export async function updateProjectTechnology(projectId, technologyId, userId, payload) {
  const { data: membership } = await supabaseAdmin
    .from('project_members')
    .select('team_role')
    .eq('project_id', projectId)
    .eq('student_id', userId)
    .eq('membership_status', 'active')
    .single();

  if (!membership || membership.team_role !== 'leader') {
    throw AppError(403, 'FORBIDDEN', 'Only the leader can manage technologies');
  }

  const { data, error } = await supabaseAdmin
    .from('project_technologies')
    .update({
      usage_status: payload.usage_status,
      purpose: payload.purpose,
      updated_at: new Date().toISOString(),
    })
    .eq('project_id', projectId)
    .eq('technology_id', technologyId)
    .select(
      `
      id, usage_status, purpose,
      technology:technologies(id, name, category)
    `
    )
    .single();

  if (error) {
    throw AppError(500, 'UPDATE_FAILED', 'Failed to update technology');
  }

  return data;
}
