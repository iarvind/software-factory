import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invalidate, post, useApi } from "../lib/api";
import { splitList } from "../lib/format";
import { PRIORITY } from "../lib/status";
import type { BoardData, Item } from "../lib/types";
import { Button, Field, Input, Select, Sheet, Textarea, toast } from "./ui";

type Draft = { title: string; body: string; projectId: string; priority: string; labels: string };
const EMPTY: Draft = { title: "", body: "", projectId: "", priority: "3", labels: "" };

/** The request form: what a person wants built, fixed or answered, and where. */
export function RequestForm({ onDone, compact, footer }: { onDone?: (item: Item) => void; compact?: boolean; footer?: (submit: () => void, busy: boolean, ok: boolean) => React.ReactNode }) {
  const { data: board } = useApi<BoardData>("/api/board");
  const projects = board?.projects ?? [];
  const [d, setD] = useState<Draft>(() => ({ ...EMPTY, projectId: projects.length === 1 ? String(projects[0].id) : "" }));
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const ok = d.title.trim().length >= 2;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const item = await post<Item>("/api/items", {
        title: d.title.trim(), body: d.body, projectId: d.projectId ? Number(d.projectId) : null, priority: Number(d.priority), labels: splitList(d.labels).slice(0, 20),
      });
      invalidate("/api/board", "/api/items?");
      toast(`Request #${item.id} is in`);
      setD({ ...EMPTY, projectId: d.projectId });
      if (onDone) onDone(item); else navigate(`/items/${item.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="What do you need?" required>
        <Input value={d.title} onChange={set("title")} placeholder="The export button times out on large accounts" maxLength={300} />
      </Field>
      <Field label="Details" hint="What happens now, what should happen, where to look, and what done means. Links are fine.">
        <Textarea value={d.body} onChange={set("body")} rows={compact ? 5 : 8} placeholder={"Steps to reproduce, the error you see, the file or page involved…"} />
      </Field>
      <div className="grid3">
        <Field label="Project" hint={projects.length ? undefined : "Add a project first; without one the request waits in the inbox."}>
          <Select value={d.projectId} onChange={set("projectId")}>
            <option value="">Not decided</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.paused ? " (paused)" : ""}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={d.priority} onChange={set("priority")}>
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{PRIORITY[p]} (P{p})</option>)}
          </Select>
        </Field>
        <Field label="Labels" hint="Comma separated">
          <Input value={d.labels} onChange={set("labels")} placeholder="bug, billing" />
        </Field>
      </div>
      {footer ? footer(submit, busy, ok) : <div className="form-actions"><Button type="submit" disabled={!ok || busy}>{busy ? "Sending…" : "Send request"}</Button></div>}
    </form>
  );
}

export function NewRequestSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Sheet open={open} onClose={onClose} title="New request" wide>
      <RequestForm compact onDone={(item) => { onClose(); navigate(`/items/${item.id}`); }}
        footer={(_submit, busy, ok) => (
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ok || busy}>{busy ? "Sending…" : "Send request"}</Button>
          </div>
        )} />
    </Sheet>
  );
}
