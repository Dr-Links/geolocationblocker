"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Field, FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { createPlanAction, updatePlanAction } from "../actions";

export interface PlanFormValues {
  id?: string;
  key: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: "MONTH" | "YEAR";
  maxPostsPerMonth: number;
  monthlyCredits: number;
  maxSocialAccounts: number;
  maxMembers: number;
  features: { video: boolean; byok: boolean; recurring: boolean };
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
}

const FEATURES = [
  ["video", "AI video generation"],
  ["byok", "Bring your own AI keys"],
  ["recurring", "Recurring posts"],
] as const;

function Check({ name, label, defaultChecked, disabled }: { name: string; label: string; defaultChecked: boolean; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="size-4 accent-current" />
      {label}
      {disabled ? <input type="hidden" name={name} value={defaultChecked ? "on" : ""} /> : null}
    </label>
  );
}

export function PlanForm({ plan, subscriberCount = 0 }: { plan: PlanFormValues; subscriberCount?: number }) {
  const editing = !!plan.id;
  const [state, action, pending] = useActionState<ActionState, FormData>(editing ? updatePlanAction : createPlanAction, {});
  const fe = state.fieldErrors ?? {};
  const isFree = plan.key === "free";
  return (
    <form action={action} className="grid gap-6">
      {editing ? <input type="hidden" name="planId" value={plan.id} /> : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Name" defaultValue={plan.name} required errors={fe.name} />
        <Field name="key" label="Key (permanent id)" defaultValue={plan.key} readOnly={editing} required errors={fe.key}
          hint={editing ? "Keys can't change after creation." : "e.g. pro-yearly"} />
        <div className="sm:col-span-2"><Field name="description" label="Description" defaultValue={plan.description} errors={fe.description} /></div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Field name="price" label="Price" inputMode="decimal" defaultValue={(plan.priceCents / 100).toFixed(2)} readOnly={isFree}
          errors={fe.priceCents} hint={isFree ? "The free plan is always $0." : "In the currency below, e.g. 49.00"} />
        <div className="grid gap-2">
          <Label htmlFor="currency">Currency</Label>
          <NativeSelect id="currency" name="currency" defaultValue={plan.currency}>
            {["usd", "eur", "gbp", "cad", "aud"].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="interval">Billing interval</Label>
          <NativeSelect id="interval" name="interval" defaultValue={plan.interval}>
            <option value="MONTH">Monthly</option>
            <option value="YEAR">Yearly</option>
          </NativeSelect>
        </div>
        {editing && subscriberCount > 0 ? (
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Changing the price, currency or interval creates a new price for new customers. The {subscriberCount} current
            subscriber{subscriberCount === 1 ? "" : "s"} keep their existing price (grandfathered).
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-4">
        <p className="text-sm font-medium sm:col-span-4">Limits per billing period (-1 = unlimited)</p>
        <Field name="maxPostsPerMonth" label="Posts" type="number" min={-1} defaultValue={plan.maxPostsPerMonth} errors={fe.maxPostsPerMonth} />
        <Field name="monthlyCredits" label="AI credits" type="number" min={-1} defaultValue={plan.monthlyCredits} errors={fe.monthlyCredits} />
        <Field name="maxSocialAccounts" label="Connected accounts" type="number" min={-1} defaultValue={plan.maxSocialAccounts} errors={fe.maxSocialAccounts} />
        <Field name="maxMembers" label="Members" type="number" min={-1} defaultValue={plan.maxMembers} errors={fe.maxMembers} />
      </section>

      <section className="grid gap-3">
        <p className="text-sm font-medium">Features</p>
        <div className="flex flex-wrap gap-6">
          {FEATURES.map(([k, label]) => <Check key={k} name={`feature_${k}`} label={label} defaultChecked={plan.features[k]} />)}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3 sm:items-end">
        <Check name="isActive" label="Active (can be purchased)" defaultChecked={plan.isActive} disabled={isFree} />
        <Check name="isPublic" label="Shown on the pricing page" defaultChecked={plan.isPublic} />
        <Field name="sortOrder" label="Sort order" type="number" min={0} defaultValue={plan.sortOrder} errors={fe.sortOrder} />
      </section>

      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-fit">{pending ? "Saving…" : editing ? "Save plan" : "Create plan"}</Button>
    </form>
  );
}
