import { notFound } from 'next/navigation';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { accountService } from '@/lib/account-service';
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { createServerSupabase, createAdminSupabaseClient } from '@/lib/supabase-server';
import { checkPermissionHybrid } from '@/lib/permission-checker';
import { AccountEstimatesClient } from '@/components/account-estimates-client';

interface EstimatesPageProps {
  params: Promise<{ accountId: string }>;
}

export default async function AccountEstimatesPage({ params }: EstimatesPageProps) {
  const { accountId } = await params;
  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">Please log in to view estimates.</p>
        </div>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  if (!supabase) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Database Error</h1>
          <p className="text-muted-foreground mt-2">Unable to connect to database.</p>
        </div>
      </div>
    );
  }

  const hasEstimateView =
    (await checkPermissionHybrid(userProfile as any, Permission.VIEW_ESTIMATES, { accountId }, supabase)) ||
    (await checkPermissionHybrid(userProfile as any, Permission.VIEW_ALL_ESTIMATES, undefined, supabase)) ||
    (await hasPermission(userProfile as any, Permission.VIEW_ACCOUNTS, { accountId })) ||
    (await hasPermission(userProfile as any, Permission.VIEW_ALL_ACCOUNTS)) ||
    (await accountService.canUserAccessAccount((userProfile as any).id, accountId, supabase));

  if (!hasEstimateView) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">
            You don&apos;t have permission to view estimates for this account.
          </p>
        </div>
      </div>
    );
  }

  const hasEstimateManage =
    (await checkPermissionHybrid(userProfile as any, Permission.MANAGE_ESTIMATES, { accountId }, supabase)) ||
    (await hasPermission(userProfile as any, Permission.MANAGE_ACCOUNTS, { accountId }));

  const adminClient = createAdminSupabaseClient();
  const queryClient = (adminClient || supabase) as any;
  const account = await accountService.getAccountById(accountId, undefined, queryClient);
  if (!account) notFound();

  const { data: projects } = await queryClient
    .from('projects')
    .select('id, name')
    .eq('account_id', accountId)
    .order('name');

  const { data: estimates } = await queryClient
    .from('estimates')
    .select('*, estimate_line_items(*)')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });

  return (
    <AccountEstimatesClient
      accountId={accountId}
      accountName={(account as any).name || 'Account'}
      initialEstimates={estimates || []}
      projects={projects || []}
      canManage={!!hasEstimateManage}
    />
  );
}