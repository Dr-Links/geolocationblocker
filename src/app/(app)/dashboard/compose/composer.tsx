"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Send, X as XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PublicGeneration } from "@/server/ai/service";
import type { TargetCheck } from "@/server/scheduling/posts";
import { saveAndScheduleAction, savePostAction, unscheduleAction } from "./actions";
import { AiPanel } from "./ai-panel";
import { MediaUpload } from "./media-upload";
import { MediaPreview } from "./media-preview";
import { PlatformPreview } from "./platform-preview";
import type { ComposerMedia, ComposerOptions, TargetAccount } from "./types";

const LABEL: Record<string, string> = { X: "X", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", LINKEDIN: "LinkedIn", TIKTOK: "TikTok", YOUTUBE: "YouTube" };
const DAYS = [["MO", "Mon"], ["TU", "Tue"], ["WE", "Wed"], ["TH", "Thu"], ["FR", "Fri"], ["SA", "Sat"], ["SU", "Sun"]] as const;
const textareaCls = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface ComposerInitial {
  postId?: string;
  status?: string;
  content: string;
  overrides: Record<string, string>;
  media: ComposerMedia[];
  accountIds: string[];
  scheduledLabel?: string | null;
  repeatLabel?: string | null;
}

export function Composer({ options, initial, recent, accounts, workspaceTz, timezones, canRecur, defaultLocal, hasQueueSlots }: {
  options: ComposerOptions;
  initial: ComposerInitial;
  recent: PublicGeneration[];
  accounts: TargetAccount[];
  workspaceTz: string;
  timezones: string[];
  canRecur: boolean;
  defaultLocal: string;
  hasQueueSlots: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState(initial.content);
  const [overrides, setOverrides] = useState<Record<string, string>>(initial.overrides);
  const [media, setMedia] = useState<ComposerMedia[]>(initial.media);
  const [selected, setSelected] = useState<string[]>(initial.accountIds);
  const [tab, setTab] = useState<string>("ALL");

  const [mode, setMode] = useState<"now" | "at" | "queue">("at");
  const [local, setLocal] = useState(defaultLocal);
  const [tz, setTz] = useState(workspaceTz);
  const [repeat, setRepeat] = useState<"" | "DAILY" | "WEEKLY" | "MONTHLY">("");
  const [days, setDays] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checks, setChecks] = useState<TargetCheck[] | null>(null);
  const [busy, start] = useTransition();
  // The post id once saved. Tracked in state (not via navigation) so a failed schedule
  // attempt on a NEW post doesn't remount the composer and lose its error list, and
  // repeated attempts update the same draft instead of creating new ones.
  const [postId, setPostId] = useState(initial.postId);
  const rememberPost = (id: string | undefined) => {
    if (!id || id === postId) return;
    setPostId(id);
    window.history.replaceState(null, "", `/dashboard/compose?post=${id}`);
  };

  const editable = !initial.status || ["DRAFT", "SCHEDULED", "FAILED"].includes(initial.status);
  const targets = accounts.filter((a) => selected.includes(a.id));
  const platforms = useMemo(() => [...new Set(targets.map((t) => t.platform))], [targets]);
  const textFor = (p: string) => (overrides[p]?.trim() ? overrides[p]! : content);
  const payload = () => ({
    postId,
    content,
    platformOverrides: Object.fromEntries(Object.entries(overrides).filter(([p, v]) => v.trim() && platforms.includes(p)).map(([p, v]) => [p, { content: v }])),
    mediaAssetIds: media.map((m) => m.id),
    accountIds: selected,
  });

  const activeText = tab === "ALL" ? content : (overrides[tab] ?? "");
  const setActiveText = (v: string) => (tab === "ALL" ? setContent(v) : setOverrides((o) => ({ ...o, [tab]: v })));

  function save() {
    setMsg(null);
    start(async () => {
      const r = await savePostAction(payload());
      setMsg({ ok: !!r.ok, text: r.ok ? "Draft saved." : (r.error ?? Object.values(r.fieldErrors ?? {}).flat()[0] ?? "Couldn't save") });
      rememberPost(r.postId);
    });
  }

  function schedule() {
    setMsg(null);
    setChecks(null);
    start(async () => {
      const r = await saveAndScheduleAction(payload(), {
        mode,
        localDateTime: mode === "at" ? local : undefined,
        timezone: tz,
        recurrence: repeat ? { freq: repeat, interval: 1, byDay: repeat === "WEEKLY" && days.length ? (days as never) : undefined } : null,
      });
      if (r.ok) {
        router.push(`/dashboard/posts?tab=${mode === "now" ? "all" : "scheduled"}&notice=${mode === "now" ? "publishing" : "scheduled"}`);
        return;
      }
      if (r.checks) setChecks(r.checks.filter((c) => !c.ok));
      setMsg({ ok: false, text: r.error ?? Object.values(r.fieldErrors ?? {}).flat()[0] ?? "Couldn't schedule" });
      rememberPost(r.postId);
    });
  }

  function unschedule() {
    start(async () => {
      const r = await unscheduleAction(postId!);
      setMsg({ ok: !!r.ok, text: r.ok ? r.message! : r.error! });
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      {initial.status && initial.status !== "DRAFT" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm" data-testid="post-status-banner">
          <span>
            <Badge variant={initial.status === "FAILED" ? "destructive" : "outline"}>{initial.status.replace("_", " ").toLowerCase()}</Badge>{" "}
            {initial.scheduledLabel ? `for ${initial.scheduledLabel}` : ""}{initial.repeatLabel ? ` · ${initial.repeatLabel}` : ""}
          </span>
          {initial.status === "SCHEDULED" ? <Button size="sm" variant="outline" onClick={unschedule} disabled={busy}>Unschedule</Button> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{postId ? "Edit post" : "New post"}</CardTitle>
            <CardDescription>Write once, then customize per platform if you want.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4">
            <div className="grid gap-2">
              <Label>Publish to</Label>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No connected accounts. <a href="/dashboard/accounts" className="underline">Connect one</a> to publish.</p>
              ) : (
                <div className="flex flex-wrap gap-2" data-testid="target-accounts">
                  {accounts.map((a) => (
                    <label key={a.id} className={cn("flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs", selected.includes(a.id) && "border-primary bg-accent", a.status !== "CONNECTED" && "opacity-60")}>
                      <input type="checkbox" className="size-3.5" disabled={!editable} checked={selected.includes(a.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                      {LABEL[a.platform]} · {a.label}{a.isMock ? " (mock)" : ""}{a.status !== "CONNECTED" ? ` (${a.status.toLowerCase()})` : ""}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Text per platform">
                {["ALL", ...platforms].map((p) => (
                  <button key={p} type="button" role="tab" aria-selected={tab === p} onClick={() => setTab(p)}
                    className={cn("rounded-md px-2.5 py-1 text-xs", tab === p ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    {p === "ALL" ? "All platforms" : `${LABEL[p]}${overrides[p]?.trim() ? " •" : ""}`}
                  </button>
                ))}
              </div>
              <Label htmlFor="post-content" className="sr-only">Post text</Label>
              <textarea id="post-content" aria-label={tab === "ALL" ? "Post text" : `${LABEL[tab]} text`} value={activeText} disabled={!editable}
                onChange={(e) => setActiveText(e.target.value)} rows={7} className={textareaCls}
                placeholder={tab === "ALL" ? "What do you want to share?" : `Custom text for ${LABEL[tab]} (leave empty to use the shared text)`} />
              {tab !== "ALL" ? <p className="text-xs text-muted-foreground">Only {LABEL[tab]} uses this text. Empty = the shared text.</p> : null}
            </div>

            <div className="grid gap-2">
              <Label>Media</Label>
              {media.length === 0 ? <p className="text-sm text-muted-foreground">Nothing attached. Upload a file, or generate an image or video and click Attach.</p> : null}
              <div className="grid grid-cols-3 gap-2" data-testid="attached-media">
                {media.map((m) => (
                  <div key={m.id} className="relative">
                    <MediaPreview m={m} className="aspect-square w-full" />
                    {editable ? (
                      <button type="button" aria-label="Remove attachment" onClick={() => setMedia((x) => x.filter((y) => y.id !== m.id))} className="absolute right-1 top-1 rounded-full bg-background/90 p-1 shadow">
                        <XIcon className="size-3" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {editable ? <MediaUpload onUploaded={(m) => setMedia((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]))} /> : null}
            </div>

            {editable ? (
              <div className="grid gap-3 rounded-md border p-3" data-testid="schedule-panel">
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="When">
                  {([["at", "Schedule"], ["now", "Publish now"], ["queue", "Add to queue"]] as const).map(([m, l]) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                      className={cn("rounded-md px-3 py-1.5 text-sm", mode === m ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{l}</button>
                  ))}
                </div>
                {mode === "at" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="sched-at">Date &amp; time</Label>
                      <Input id="sched-at" type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="sched-tz">Timezone</Label>
                      <NativeSelect id="sched-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                        {timezones.map((z) => <option key={z} value={z}>{z}</option>)}
                      </NativeSelect>
                    </div>
                  </div>
                ) : mode === "queue" ? (
                  <p className="text-sm text-muted-foreground">{hasQueueSlots ? "Goes into the next free posting slot." : <>No posting slots yet. Set them on the <a className="underline" href="/dashboard/calendar">Calendar</a>.</>}</p>
                ) : null}
                {mode !== "now" ? (
                  <div className="grid gap-2">
                    <Label htmlFor="sched-repeat">Repeat</Label>
                    <NativeSelect id="sched-repeat" value={repeat} disabled={!canRecur} onChange={(e) => setRepeat(e.target.value as never)}>
                      <option value="">Doesn&apos;t repeat</option>
                      <option value="DAILY">Daily</option>
                      <option value="WEEKLY">Weekly</option>
                      <option value="MONTHLY">Monthly</option>
                    </NativeSelect>
                    {!canRecur ? <p className="text-xs text-muted-foreground">Recurring posts need a plan with recurring posts. <a href="/dashboard/billing" className="underline">Upgrade</a></p> : null}
                    {repeat === "WEEKLY" ? (
                      <div className="flex flex-wrap gap-1">
                        {DAYS.map(([code, l]) => (
                          <label key={code} className={cn("cursor-pointer rounded-md border px-2 py-1 text-xs", days.includes(code) && "border-primary bg-accent")}>
                            <input type="checkbox" className="sr-only" checked={days.includes(code)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, code] : d.filter((x) => x !== code)))} />
                            {l}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {checks?.length ? (
                  <ul className="grid gap-1 text-sm" data-testid="schedule-problems">
                    {checks.map((c) => <li key={c.accountId} className="text-destructive">⛔ {LABEL[c.platform]} · {c.label}: {c.errors.map((e) => e.message).join(" ")}</li>)}
                  </ul>
                ) : null}
                {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={schedule} disabled={busy || !selected.length || (!content.trim() && !media.length)}>
                    {mode === "now" ? <><Send /> Publish now</> : <><CalendarClock /> {mode === "queue" ? "Add to queue" : initial.status === "SCHEDULED" ? "Reschedule" : "Schedule"}</>}
                  </Button>
                  <Button variant="outline" onClick={save} disabled={busy || (!content.trim() && !media.length)}>Save draft</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This post has been published and can&apos;t be edited. See <a href="/dashboard/posts" className="underline">Posts</a>.</p>
            )}
          </CardContent>
        </Card>

        <AiPanel
          options={options}
          recent={recent}
          attachedIds={media.map((m) => m.id)}
          onUseText={(t) => setActiveText(t)}
          onAppendText={(t) => setActiveText(activeText ? `${activeText}\n\n${t}` : t)}
          onAttach={(m) => setMedia((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]))}
        />
      </div>

      {targets.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>How it will look on each platform, checked against its rules as you type.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="previews">
            {targets.map((a) => <PlatformPreview key={a.id} account={a} text={textFor(a.platform)} media={media} />)}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
