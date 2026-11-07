"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageIcon, Loader2, Sparkles, Type, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PublicGeneration } from "@/server/ai/service";
import { generateAction } from "./actions";
import { MediaPreview } from "./media-preview";
import type { ComposerMedia, ComposerOptions, GenType } from "./types";

const TABS: { type: GenType; label: string; icon: typeof Type }[] = [
  { type: "TEXT", label: "Caption", icon: Type },
  { type: "IMAGE", label: "Image", icon: ImageIcon },
  { type: "VIDEO", label: "Video", icon: Video },
];
const PLATFORMS = ["", "X", "INSTAGRAM", "FACEBOOK", "LINKEDIN", "TIKTOK", "YOUTUBE"];
const textareaCls = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function AiPanel({ options, recent, onUseText, onAppendText, onAttach, attachedIds }: {
  options: ComposerOptions;
  recent: PublicGeneration[];
  onUseText: (t: string) => void;
  onAppendText: (t: string) => void;
  onAttach: (m: ComposerMedia) => void;
  attachedIds: string[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<GenType>("TEXT");
  const cfg = options.types[tab];
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("AUTO");
  const [model, setModel] = useState("");
  const [platform, setPlatform] = useState("");
  const [tone, setTone] = useState("");
  const [variants, setVariants] = useState(2);
  const [aspect, setAspect] = useState("1:1");
  const [genError, setGenError] = useState<string | null>(null);
  const [current, setCurrent] = useState<PublicGeneration | null>(null);
  const [history, setHistory] = useState<PublicGeneration[]>(recent);
  const [submitting, startGen] = useTransition();
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (poll.current && clearTimeout(poll.current)), []);
  useEffect(() => {
    setProvider("AUTO");
    setModel("");
    setGenError(null);
  }, [tab]);

  const pending = current && (current.status === "QUEUED" || current.status === "RUNNING");

  function track(id: string) {
    const tick = async () => {
      const res = await fetch(`/api/generations/${id}`, { cache: "no-store" });
      if (!res.ok) return setGenError("Lost track of the generation. Refresh to see it.");
      const g = (await res.json()) as PublicGeneration;
      setCurrent(g);
      if (g.status === "QUEUED" || g.status === "RUNNING") poll.current = setTimeout(tick, 1200);
      else {
        setHistory((h) => [g, ...h.filter((x) => x.id !== g.id)].slice(0, 8));
        router.refresh();
      }
    };
    void tick();
  }

  function generate() {
    setGenError(null);
    startGen(async () => {
      const res = await generateAction({
        type: tab,
        prompt,
        provider: provider as never,
        model: model || undefined,
        options: tab === "TEXT" ? { platform: platform || undefined, tone: tone || undefined, variants } : { aspectRatio: aspect as never },
      });
      if (!res.ok || !res.id) return setGenError(res.error ?? Object.values(res.fieldErrors ?? {}).flat()[0] ?? "Couldn't start the generation");
      setCurrent({ id: res.id, type: tab, status: "QUEUED" } as PublicGeneration);
      track(res.id);
    });
  }

  const modelSuggestions = cfg.providers.find((p) => p.provider === (provider === "AUTO" ? cfg.providers[0]?.provider : provider))?.models ?? [];

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles className="size-4" /> Generate with AI</CardTitle>
        <CardDescription>{options.creditsLeft === null ? "Unlimited credits" : <span data-testid="credits-left">{options.creditsLeft} credits left</span>} this period</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {TABS.map(({ type, label, icon: Icon }) => (
            <button key={type} type="button" role="tab" aria-selected={tab === type} onClick={() => setTab(type)}
              className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm", tab === type ? "bg-background shadow-sm" : "text-muted-foreground")}>
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>

        {!cfg.allowed ? (
          <p className="text-sm text-muted-foreground" data-testid="video-locked">AI video isn&apos;t included in your plan. <a href="/dashboard/billing" className="underline">Upgrade</a> to use it.</p>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="gen-prompt">{tab === "TEXT" ? "Brief" : "Describe the " + (tab === "IMAGE" ? "image" : "video")}</Label>
              <textarea id="gen-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className={textareaCls}
                placeholder={tab === "TEXT" ? "e.g. Announce our new pumpkin cold brew, playful, for Instagram" : tab === "IMAGE" ? "e.g. Pumpkin cold brew on a rustic table, autumn light" : "e.g. Slow pour of cold brew over ice, close-up"} />
            </div>
            {tab === "TEXT" ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="gen-platform">Platform</Label>
                  <NativeSelect id="gen-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                    {PLATFORMS.map((p) => <option key={p} value={p}>{p || "Any"}</option>)}
                  </NativeSelect>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="gen-tone">Tone</Label>
                  <Input id="gen-tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="friendly" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="gen-variants">Options</Label>
                  <NativeSelect id="gen-variants" value={variants} onChange={(e) => setVariants(Number(e.target.value))}>
                    {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                  </NativeSelect>
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="gen-aspect">Aspect ratio</Label>
                <NativeSelect id="gen-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                  {["1:1", "4:5", "9:16", "16:9"].map((a) => <option key={a} value={a}>{a}</option>)}
                </NativeSelect>
              </div>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Provider &amp; model</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="gen-provider">Provider</Label>
                  <NativeSelect id="gen-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    <option value="AUTO">Workspace default{cfg.preference.provider !== "AUTO" ? ` (${cfg.preference.provider})` : ""}</option>
                    {cfg.providers.map((p) => <option key={p.provider} value={p.provider}>{p.label}{p.byok ? " · your key" : ""}</option>)}
                  </NativeSelect>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="gen-model">Model (optional)</Label>
                  <Input id="gen-model" list="model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelSuggestions[0] ?? "default"} />
                  <datalist id="model-suggestions">{modelSuggestions.map((m) => <option key={m} value={m} />)}</datalist>
                </div>
              </div>
            </details>
            {genError ? <p role="alert" className="text-sm text-destructive">{genError}</p> : null}
            <Button onClick={generate} disabled={submitting || !!pending || prompt.trim().length < 3}>
              {submitting || pending ? <><Loader2 className="animate-spin" /> Generating…</> : <>Generate · {cfg.cost} credit{cfg.cost === 1 ? "" : "s"}</>}
            </Button>
          </>
        )}

        {current && current.status !== "QUEUED" && current.status !== "RUNNING" ? (
          <GenerationResult g={current} onUseText={onUseText} onAppendText={onAppendText} onAttach={onAttach} attachedIds={attachedIds} />
        ) : null}

        {history.length ? (
          <div className="grid grid-cols-1 gap-2 border-t pt-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">Recent</p>
            <div className="grid grid-cols-1 gap-2" data-testid="generation-history">
              {history.filter((g) => g.id !== current?.id).slice(0, 5).map((g) => (
                <button key={g.id} type="button" onClick={() => setCurrent(g)} className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm hover:bg-accent">
                  <span className="min-w-0 truncate">{g.prompt}</span>
                  <Badge variant={g.status === "FAILED" ? "destructive" : "outline"}>{g.type.toLowerCase()}</Badge>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GenerationResult({ g, onUseText, onAppendText, onAttach, attachedIds }: {
  g: PublicGeneration;
  onUseText: (t: string) => void;
  onAppendText: (t: string) => void;
  onAttach: (m: ComposerMedia) => void;
  attachedIds: string[];
}) {
  if (g.status === "FAILED") return <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="generation-error">{g.error}</p>;
  const meta = (
    <p className="text-xs text-muted-foreground" data-testid="generation-meta">
      {g.provider === "MOCK" ? "Mock provider (placeholder)" : g.provider} · {g.model}
      {g.fallbackFrom ? ` · fell back from ${g.fallbackFrom}` : ""}
      {g.usedByok ? " · your API key, no credits used" : ` · ${g.creditsCharged} credit${g.creditsCharged === 1 ? "" : "s"}`}
    </p>
  );
  if (g.type === "TEXT") {
    return (
      <div className="grid gap-3" data-testid="generation-result">
        {(g.output?.variants ?? []).map((v, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-3">
            <p className="whitespace-pre-wrap text-sm">{v}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onUseText(v)}>Use</Button>
              <Button size="sm" variant="outline" onClick={() => onAppendText(v)}>Append</Button>
            </div>
          </div>
        ))}
        {meta}
      </div>
    );
  }
  const out = g.output as { mediaAssetId?: string; mimeType?: string; width?: number; height?: number; durationMs?: number } | null;
  const id = out?.mediaAssetId;
  return (
    <div className="grid gap-3" data-testid="generation-result">
      {id ? <MediaPreview m={{ id, kind: g.type }} className="max-h-80 w-full object-contain" /> : null}
      <Button size="sm" className="w-fit" disabled={!id || attachedIds.includes(id)}
        onClick={() => id && onAttach({ id, kind: g.type === "VIDEO" ? "VIDEO" : "IMAGE", mimeType: out?.mimeType ?? "", width: out?.width, height: out?.height, durationMs: out?.durationMs })}>
        {id && attachedIds.includes(id) ? "Attached" : "Attach to post"}
      </Button>
      {meta}
    </div>
  );
}
