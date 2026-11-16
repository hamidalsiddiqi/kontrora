'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-config';

type LineItemDraft = {
  id: string;
  description: string;
  quantity: number;
  unit_amount: number; // minor units
};

type Estimate = {
  id: string;
  account_id: string;
  project_id: string | null;
  title: string;
  notes: string | null;
  currency: string;
  status: 'draft' | 'sent' | 'accepted' | 'rejected';
  subtotal_amount: number | string;
  total_amount: number | string;
  created_at: string;
  estimate_line_items?: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_amount: number | string;
    total_amount: number | string;
    sort_order: number;
  }>;
};

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(amountMinor: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function statusBadgeVariant(status: Estimate['status']) {
  if (status === 'accepted') return 'default' as const;
  if (status === 'rejected') return 'destructive' as const;
  return 'secondary' as const;
}

export function AccountEstimatesClient({
  accountId,
  accountName,
  initialEstimates,
  projects,
  canManage,
}: {
  accountId: string;
  accountName: string;
  initialEstimates: Estimate[];
  projects: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [estimates, setEstimates] = useState<Estimate[]>(initialEstimates || []);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [projectId, setProjectId] = useState<string>('none');
  const [currency, setCurrency] = useState('USD');
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([
    { id: uuidv4(), description: '', quantity: 1, unit_amount: 0 },
  ]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return estimates;
    return estimates.filter((e) => e.status === statusFilter);
  }, [estimates, statusFilter]);

  const draftTotal = lineItems.reduce(
    (sum, li) => sum + Math.max(0, li.quantity || 0) * Math.max(0, li.unit_amount || 0),
    0,
  );

  function resetForm() {
    setTitle('');
    setNotes('');
    setProjectId('none');
    setCurrency('USD');
    setLineItems([{ id: uuidv4(), description: '', quantity: 1, unit_amount: 0 }]);
  }

  function updateLineItem(id: string, patch: Partial<LineItemDraft>) {
    setLineItems((prev) => prev.map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }

  function addLineItem() {
    setLineItems((prev) => [...prev, { id: uuidv4(), description: '', quantity: 1, unit_amount: 0 }]);
  }

  function removeLineItem(id: string) {
    setLineItems((prev) => (prev.length <= 1 ? prev : prev.filter((li) => li.id !== id)));
  }

  async function createDraft() {
    if (!canManage) return;
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    const cleanedItems = lineItems
      .map((li) => ({
        description: li.description.trim(),
        quantity: Number(li.quantity),
        unit_amount: Number(li.unit_amount),
      }))
      .filter((li) => li.description.length > 0);

    if (cleanedItems.length === 0) {
      toast.error('Add at least one line item with a description');
      return;
    }
    if (cleanedItems.some((li) => !Number.isInteger(li.quantity) || li.quantity <= 0)) {
      toast.error('Each line item quantity must be a positive integer');
      return;
    }
    if (cleanedItems.some((li) => !Number.isInteger(li.unit_amount) || li.unit_amount < 0)) {
      toast.error('Unit amounts must be integers in minor units (>= 0)');
      return;
    }

    setSaving(true);
    try {
      const idemKey = uuidv4();
      const res = await apiFetch(`/api/accounts/${accountId}/estimates`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: JSON.stringify({
          title: title.trim(),
          notes: notes.trim() || null,
          project_id: projectId === 'none' ? null : projectId,
          currency,
          line_items: cleanedItems,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to create estimate');
      }
      const created: Estimate = data.estimate;
      setEstimates((prev) => [created, ...prev]);
      toast.success(data.idempotent ? 'Estimate already existed (idempotent)' : 'Draft estimate created');
      setCreateOpen(false);
      resetForm();
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create estimate');
    } finally {
      setSaving(false);
    }
  }

  async function transitionStatus(estimateId: string, nextStatus: 'sent' | 'accepted' | 'rejected') {
    if (!canManage) return;
    try {
      const res = await apiFetch(`/api/accounts/${accountId}/estimates/${estimateId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to update estimate');
      const updated = data.estimate as Estimate;
      setEstimates((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      toast.success(`Estimate marked as ${nextStatus}`);
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update estimate');
    }
  }

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-muted-foreground mb-1 text-sm">
            <Link href={`/accounts/${accountId}`} className="hover:underline">
              {accountName}
            </Link>{' '}
            / Estimates
          </div>
          <h1 className="text-foreground text-2xl font-bold">Estimates</h1>
          <p className="text-muted-foreground text-sm">
            Account-scoped estimates with draft → sent → accepted/rejected lifecycle (no hard deletes).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          {canManage && (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>Create draft</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Create estimate draft</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="estimate-title">Title</Label>
                      <Input
                        id="estimate-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. Website redesign estimate"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Project (optional)</Label>
                      <Select value={projectId} onValueChange={setProjectId}>
                        <SelectTrigger>
                          <SelectValue placeholder="No project" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No project</SelectItem>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="estimate-currency">Currency</Label>
                      <Input
                        id="estimate-currency"
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                        maxLength={3}
                      />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="estimate-notes">Notes</Label>
                      <Textarea
                        id="estimate-notes"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Optional notes"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Line items (amounts in minor units)</Label>
                      <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                        Add line item
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {lineItems.map((li, idx) => {
                        const lineTotal = Math.max(0, li.quantity || 0) * Math.max(0, li.unit_amount || 0);
                        return (
                          <div key={li.id} className="rounded-md border p-3">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-sm font-medium">Item {idx + 1}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeLineItem(li.id)}
                                disabled={lineItems.length === 1}
                              >
                                Remove
                              </Button>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-12">
                              <div className="space-y-1 sm:col-span-6">
                                <Label>Description</Label>
                                <Input
                                  value={li.description}
                                  onChange={(e) => updateLineItem(li.id, { description: e.target.value })}
                                  placeholder="Service or deliverable"
                                />
                              </div>
                              <div className="space-y-1 sm:col-span-2">
                                <Label>Qty</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={li.quantity}
                                  onChange={(e) =>
                                    updateLineItem(li.id, { quantity: parseInt(e.target.value || '0', 10) })
                                  }
                                />
                              </div>
                              <div className="space-y-1 sm:col-span-2">
                                <Label>Unit (minor)</Label>
                                <Input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={li.unit_amount}
                                  onChange={(e) =>
                                    updateLineItem(li.id, { unit_amount: parseInt(e.target.value || '0', 10) })
                                  }
                                />
                              </div>
                              <div className="space-y-1 sm:col-span-2">
                                <Label>Total</Label>
                                <div className="text-foreground flex h-10 items-center rounded-md border px-3 text-sm">
                                  {formatMoney(lineTotal, currency || 'USD')}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-end gap-2 border-t pt-3">
                      <span className="text-muted-foreground text-sm">Draft total</span>
                      <span className="text-base font-semibold">{formatMoney(draftTotal, currency || 'USD')}</span>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button onClick={createDraft} disabled={saving}>
                    {saving ? 'Creating...' : 'Create draft estimate'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Estimate list</CardTitle>
          <CardDescription>Server-filterable list (status/project supported by API). Showing {filtered.length} item(s).</CardDescription>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">No estimates found.</div>
          ) : (
            <div className="space-y-4">
              {filtered.map((estimate) => {
                const items = (estimate.estimate_line_items || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                const total = toNumber(estimate.total_amount);
                return (
                  <div key={estimate.id} className="rounded-lg border p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold">{estimate.title}</h3>
                          <Badge variant={statusBadgeVariant(estimate.status)}>{estimate.status}</Badge>
                        </div>
                        <div className="text-muted-foreground text-sm">
                          Total: <span className="text-foreground font-medium">{formatMoney(total, estimate.currency || 'USD')}</span>
                          {' · '}Created {new Date(estimate.created_at).toLocaleString()}
                        </div>
                        {estimate.notes ? <p className="text-sm">{estimate.notes}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canManage && estimate.status === 'draft' && (
                          <Button size="sm" variant="outline" onClick={() => transitionStatus(estimate.id, 'sent')}>
                            Mark sent
                          </Button>
                        )}
                        {canManage && estimate.status === 'sent' && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => transitionStatus(estimate.id, 'accepted')}>
                              Accept
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => transitionStatus(estimate.id, 'rejected')}>
                              Reject
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground border-b text-left">
                            <th className="py-2 pr-3">Line item</th>
                            <th className="py-2 pr-3">Qty</th>
                            <th className="py-2 pr-3">Unit (minor)</th>
                            <th className="py-2">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.length === 0 ? (
                            <tr>
                              <td className="text-muted-foreground py-3" colSpan={4}>
                                No line items
                              </td>
                            </tr>
                          ) : (
                            items.map((li) => (
                              <tr key={li.id} className="border-b last:border-0">
                                <td className="py-2 pr-3">{li.description}</td>
                                <td className="py-2 pr-3">{li.quantity}</td>
                                <td className="py-2 pr-3">{toNumber(li.unit_amount)}</td>
                                <td className="py-2 font-medium">
                                  {formatMoney(toNumber(li.total_amount), estimate.currency || 'USD')}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
