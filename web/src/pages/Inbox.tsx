import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { money } from "../lib/format";
import { useMe } from "../lib/session";
import type { BoardData, Item } from "../lib/types";
import { Ago, Empty, ErrorNote, Group, Input, Loading, Page, Row, Section, Select } from "../components/ui";
import { OriginIcon, PriorityMark, StatusPill } from "../components/status";
import { RequestForm } from "../components/NewRequest";

const VIEWS: Record<string, { label: string; status?: string; open?: boolean }> = {
  open: { label: "Open", open: true },
  new: { label: "Not started", status: "inbox,needs_info" },
  waiting: { label: "Waiting on a person", status: "awaiting_approval,needs_info,review" },
  working: { label: "Being worked on", status: "planning,queued,building,verifying,reviewing,fixing,merging,deploying" },
  stopped: { label: "Blocked or failed", status: "blocked,failed" },
  done: { label: "Done", status: "done" },
  all: { label: "Everything" },
};

export default function Inbox() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const view = VIEWS[params.get("view") ?? "open"] ? (params.get("view") ?? "open") : "open";
  const project = params.get("project") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const v = VIEWS[view];
  const qs = new URLSearchParams({ limit: "200" });
  if (v.status) qs.set("status", v.status);
  if (v.open) qs.set("open", "1");
  if (project) qs.set("project", project);
  if (debounced.trim()) qs.set("q", debounced.trim());
  const { data: items, error, reload } = useApi<Item[]>(`/api/items?${qs}`);
  const { data: board } = useApi<BoardData>("/api/board");
  const names = new Map((board?.projects ?? []).map((p) => [p.id, p.name]));

  return (
    <Page title="Inbox" subtitle="Send the factory a request, and find any request it has seen.">
      {me.canEdit && (
        <Section first title="New request">
          <div className="form-panel"><RequestForm /></div>
        </Section>
      )}
      <Section first={!me.canEdit} title="Requests" aside={<>
        <Select aria-label="Which requests" value={view} onChange={(e) => setParam("view", e.target.value === "open" ? "" : e.target.value)} className="sm">
          {Object.entries(VIEWS).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
        </Select>
        <Select aria-label="Project" value={project} onChange={(e) => setParam("project", e.target.value)} className="sm">
          <option value="">All projects</option>
          {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input type="search" aria-label="Search title and request" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="sm search" />
      </>}>
        {error && <ErrorNote error={error} onRetry={reload} />}
        {!items && !error && <Loading />}
        {items && !items.length && <Empty title="No requests match" hint="Try another view or clear the search." />}
        {items && items.length > 0 && (
          <Group>
            {items.map((i) => (
              <Row key={i.id} to={`/items/${i.id}`}
                leading={<span className="num quiet id-col">#{i.id}</span>}
                title={<span className="inline-tight"><PriorityMark p={i.priority} />{i.title}</span>}
                subtitle={<span className="inline-tight"><OriginIcon origin={i.origin} />{i.requester_name ?? "someone"}{i.project_id && names.get(i.project_id) ? <span>in {names.get(i.project_id)}</span> : null}<Ago iso={i.updated_at} />{i.cost_usd > 0 && <span className="num">{money(i.cost_usd)}</span>}</span>}
                trailing={<StatusPill status={i.status} gate={i.gate} />} />
            ))}
          </Group>
        )}
      </Section>
    </Page>
  );
}
