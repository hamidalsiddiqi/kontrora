const { NextResponse } = require('next/server');
const crypto = require('crypto');
const { createAdminSupabaseClient, createApiSupabaseClient } = require('@/lib/supabase-server');
const { requireAuthentication, handleGuardError } = require('@/lib/server-guards');
const { checkPermissionHybrid } = require('@/lib/permission-checker');
const { Permission } = require('@/lib/permissions');
const { isValidUUID } = require('@/lib/validation-helpers');
const {
  createEstimateSchema,
  getEstimatesQuerySchema,
  validateRequestBody,
  validateQueryParams,
} = require('@/lib/validation-schemas');

function hashRequestBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

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

async function GET(request, { params }) {
  try {
    const { accountId } = await params;
    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID format' }, { status: 400 });
    }

    const userProfile = await requireAuthentication(request);
    const requestSupabase = createApiSupabaseClient(request);
    const allowed = await canAccessAccountEstimates(userProfile, accountId, requestSupabase, 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Insufficient permissions to view estimates' }, { status: 403 });
    }

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const { data: account } = await admin.from('accounts').select('id').eq('id', accountId).maybeSingle();
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const queryObj = Object.fromEntries(searchParams.entries());
    const parsed = validateQueryParams(getEstimatesQuerySchema, queryObj);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { status, projectId, limit, offset } = parsed.data;

    let query = admin
      .from('estimates')
      .select('*, estimate_line_items(*)', { count: 'exact' })
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (projectId) query = query.eq('project_id', projectId);
    if (typeof limit === 'number') {
      const start = typeof offset === 'number' ? offset : 0;
      query = query.range(start, start + limit - 1);
    }

    const { data: estimates, error, count } = await query;
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch estimates' }, { status: 500 });
    }

    return NextResponse.json({ success: true, estimates: estimates || [], total: count || 0 }, { status: 200 });
  } catch (error) {
    return handleGuardError(error);
  }
}

async function POST(request, { params }) {
  const admin = createAdminSupabaseClient();
  try {
    const { accountId } = await params;
    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID format' }, { status: 400 });
    }

    const userProfile = await requireAuthentication(request);
    const requestSupabase = createApiSupabaseClient(request);
    const allowed = await canAccessAccountEstimates(userProfile, accountId, requestSupabase, 'manage');
    if (!allowed) {
      return NextResponse.json({ error: 'Insufficient permissions to create estimates' }, { status: 403 });
    }

    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const idempotencyKey = request.headers.get('idempotency-key') || request.headers.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length < 8 || idempotencyKey.length > 255) {
      return NextResponse.json({ error: 'Idempotency-Key header is required (8-255 chars)' }, { status: 400 });
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

    const validation = validateRequestBody(createEstimateSchema, body);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const payload = validation.data;
    const requestHash = hashRequestBody(payload);

    const { data: account } = await admin.from('accounts').select('id').eq('id', accountId).maybeSingle();
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    if (payload.project_id) {
      const { data: project } = await admin.from('projects').select('id, account_id').eq('id', payload.project_id).maybeSingle();
      if (!project || project.account_id !== accountId) {
        return NextResponse.json({ error: 'project_id must belong to the specified account' }, { status: 400 });
      }
    }

    const { data: existingKey } = await admin
      .from('estimate_idempotency_keys')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userProfile.id)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (existingKey) {
      if (existingKey.request_hash !== requestHash) {
        return NextResponse.json({ error: 'Idempotency-Key reuse with different request payload' }, { status: 409 });
      }
      if (existingKey.status === 'completed' && existingKey.response_body) {
        return NextResponse.json(existingKey.response_body, { status: 200 });
      }
      if (existingKey.estimate_id) {
        const { data: existingEstimate } = await admin
          .from('estimates').select('*, estimate_line_items(*)')
          .eq('id', existingKey.estimate_id).eq('account_id', accountId).maybeSingle();
        if (existingEstimate) {
          const responseBody = { success: true, estimate: existingEstimate, idempotent: true };
          await admin.from('estimate_idempotency_keys').update({ status: 'completed', response_body: responseBody }).eq('id', existingKey.id);
          return NextResponse.json(responseBody, { status: 200 });
        }
      }
      return NextResponse.json({ error: 'Request with this Idempotency-Key is in progress' }, { status: 409 });
    }

    const { data: keyRow, error: keyInsertError } = await admin
      .from('estimate_idempotency_keys')
      .insert({ account_id: accountId, user_id: userProfile.id, idempotency_key: idempotencyKey, request_hash: requestHash, status: 'in_progress' })
      .select().single();

    if (keyInsertError) {
      const { data: raced } = await admin
        .from('estimate_idempotency_keys').select('*')
        .eq('account_id', accountId).eq('user_id', userProfile.id).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (raced?.request_hash === requestHash && raced?.status === 'completed' && raced.response_body) {
        return NextResponse.json(raced.response_body, { status: 200 });
      }
      return NextResponse.json({ error: 'Failed to process idempotent request' }, { status: 409 });
    }

    const lineItems = payload.line_items.map((li, idx) => ({
      description: li.description,
      quantity: li.quantity,
      unit_amount: li.unit_amount,
      total_amount: li.quantity * li.unit_amount,
      sort_order: idx,
    }));
    const subtotal = lineItems.reduce((sum, li) => sum + li.total_amount, 0);
    const total = subtotal;

    const { data: estimate, error: estimateError } = await admin
      .from('estimates')
      .insert({
        account_id: accountId,
        project_id: payload.project_id || null,
        title: payload.title,
        notes: payload.notes || null,
        currency: payload.currency || 'USD',
        status: 'draft',
        subtotal_amount: subtotal,
        total_amount: total,
        created_by: userProfile.id,
      })
      .select().single();

    if (estimateError || !estimate) {
      await admin.from('estimate_idempotency_keys').delete().eq('id', keyRow.id);
      return NextResponse.json({ error: 'Failed to create estimate' }, { status: 500 });
    }

    const lineItemsPayload = lineItems.map((li) => ({ ...li, estimate_id: estimate.id }));
    const { error: lineItemsError } = await admin.from('estimate_line_items').insert(lineItemsPayload);
    if (lineItemsError) {
      await admin.from('estimate_line_items').delete().eq('estimate_id', estimate.id);
      await admin.from('estimates').delete().eq('id', estimate.id);
      await admin.from('estimate_idempotency_keys').delete().eq('id', keyRow.id);
      return NextResponse.json({ error: 'Failed to create estimate line items' }, { status: 500 });
    }

    const { data: fullEstimate } = await admin.from('estimates').select('*, estimate_line_items(*)').eq('id', estimate.id).single();
    const responseBody = { success: true, estimate: fullEstimate || estimate };
    await admin.from('estimate_idempotency_keys').update({ status: 'completed', estimate_id: estimate.id, response_body: responseBody }).eq('id', keyRow.id);

    return NextResponse.json(responseBody, { status: 201 });
  } catch (error) {
    return handleGuardError(error);
  }
}

exports.GET = GET;
exports.POST = POST;