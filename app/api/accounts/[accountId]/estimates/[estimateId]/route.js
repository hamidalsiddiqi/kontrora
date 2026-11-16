const { NextResponse } = require('next/server');
const { createAdminSupabaseClient, createApiSupabaseClient } = require('@/lib/supabase-server');
const { requireAuthentication, handleGuardError } = require('@/lib/server-guards');
const { checkPermissionHybrid } = require('@/lib/permission-checker');
const { Permission } = require('@/lib/permissions');
const { isValidUUID } = require('@/lib/validation-helpers');

async function canAccessAccountEstimates(userProfile, accountId, supabase, mode) {
  const permission = mode === 'manage' ? Permission.MANAGE_ESTIMATES : Permission.VIEW_ESTIMATES;
  const hasEstimatePerm = await checkPermissionHybrid(userProfile, permission, { accountId }, supabase);
  if (hasEstimatePerm) return true;
  if (mode === 'manage') {
    return checkPermissionHybrid(userProfile, Permission.MANAGE_ACCOUNTS, { accountId }, supabase);
  }
  return (
    (await checkPermissionHybrid(userProfile, Permission.VIEW_ACCOUNTS, { accountId }, supabase)) ||
    (await checkPermissionHybrid(userProfile, Permission.VIEW_ALL_ACCOUNTS, undefined, supabase))
  );
}

function isAllowedTransition(from, to) {
  if (from === to) return true;
  if (from === 'draft' && to === 'sent') return true;
  if (from === 'sent' && (to === 'accepted' || to === 'rejected')) return true;
  return false;
}

async function GET(request, { params }) {
  try {
    const { accountId, estimateId } = await params;
    if (!isValidUUID(accountId) || !isValidUUID(estimateId)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    const userProfile = await requireAuthentication(request);
    const requestSupabase = createApiSupabaseClient(request);
    const allowed = await canAccessAccountEstimates(userProfile, accountId, requestSupabase, 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Insufficient permissions to view estimate' }, { status: 403 });
    }

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const { data: estimate, error } = await admin
      .from('estimates')
      .select('*, estimate_line_items(*)')
      .eq('id', estimateId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) return NextResponse.json({ error: 'Failed to fetch estimate' }, { status: 500 });
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

    return NextResponse.json({ success: true, estimate }, { status: 200 });
  } catch (error) {
    return handleGuardError(error);
  }
}

async function PATCH(request, { params }) {
  try {
    const { accountId, estimateId } = await params;
    if (!isValidUUID(accountId) || !isValidUUID(estimateId)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    const userProfile = await requireAuthentication(request);
    const requestSupabase = createApiSupabaseClient(request);
    const allowed = await canAccessAccountEstimates(userProfile, accountId, requestSupabase, 'manage');
    if (!allowed) {
      return NextResponse.json({ error: 'Insufficient permissions to update estimate' }, { status: 403 });
    }

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const nextStatus = body?.status;
    const allowedStatuses = ['draft', 'sent', 'accepted', 'rejected'];
    if (!allowedStatuses.includes(nextStatus)) {
      return NextResponse.json({ error: 'Invalid status payload' }, { status: 400 });
    }

    const { data: existing, error: existingError } = await admin
      .from('estimates').select('*').eq('id', estimateId).eq('account_id', accountId).maybeSingle();
    if (existingError) return NextResponse.json({ error: 'Failed to fetch estimate' }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

    if (!isAllowedTransition(existing.status, nextStatus)) {
      return NextResponse.json({ error: `Invalid status transition from ${existing.status} to ${nextStatus}` }, { status: 409 });
    }

    const updates = { status: nextStatus };
    const now = new Date().toISOString();
    if (nextStatus === 'sent' && existing.status === 'draft') updates.sent_at = existing.sent_at || now;
    if ((nextStatus === 'accepted' || nextStatus === 'rejected') && existing.status === 'sent') {
      updates.responded_at = existing.responded_at || now;
    }

    const { data: updated, error: updateError } = await admin
      .from('estimates').update(updates).eq('id', estimateId).eq('account_id', accountId)
      .select('*, estimate_line_items(*)').single();
    if (updateError) return NextResponse.json({ error: 'Failed to update estimate' }, { status: 500 });

    return NextResponse.json({ success: true, estimate: updated }, { status: 200 });
  } catch (error) {
    return handleGuardError(error);
  }
}

exports.GET = GET;
exports.PATCH = PATCH;