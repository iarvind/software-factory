import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { useLive } from "../lib/live";
import { fmtDate } from "../lib/format";
import { familyOf, statusLabel } from "../lib/status";
import type { BoardData, Ev } from "../lib/types";
import { Ago, Empty, ErrorNote, Loading, Page, Segmented } from "../components/ui";
import { Icon } from "../components/icons";

const FEED = new Set(["status", "approval", "feedback", "post", "error", "run", "verify", "git"]);
type Filter = "all" | "status" | "people" | "problems";
const keep = (e: Ev, f: Filter) =>
  f === "all" ? true : f === "status" ? e.type === "status" : f === "people" ? e.type === "approval" || e.type === "feedback" || e.type === "post" : e.level === "error" || e.level === "warn" || e.type === "error";

export default function Activity() {
  const { data, error, reload } = useApi<Ev[]>("/api/activity?limit=200");
  const { data: board } = useApi<BoardData>("/api/board");
  const [fresh, setFresh] = useState<Ev[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  useLive((e) => { if (FEED.has(e.type)) setFresh((f) => (f.some((x) => x.id === e.id) ? f : [e, ...f].slice(0, 300))); });
  const titles = new Map((board?.items ?? []).map((i) => [i.id, i.title]));
  const seen = new Set<number>();
  const list = [...fresh, ...(data ?? [])].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).filter((e) => keep(e, filter));
  return (
    <Page title="Activity" subtitle="Everything that moved, newest first, as it happens."
      aside={<Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "status", label: "Status" }, { value: "people", label: "People" }, { value: "problems", label: "Problems" }]} />}>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !list.length && <Empty title="Quiet" hint="Nothing has happened yet that matches this view." />}
      {list.length > 0 && (
        <ol className="feed">
          {list.map((e) => {
            const d = (e.data ?? {}) as Record<string, unknown>;
            const st = e.type === "status" ? String(d.status ?? "") : "";
            return (
              <li key={e.id} className={`feed-row ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : ""}`}>
                <span className={`feed-ico ${st ? `f-${familyOf(st)}` : ""}`}>{st ? <span className="lamp" aria-hidden="true" /> : <Icon name={e.type} size={14} />}</span>
                <div className="grow">
                  <div className="feed-main">
                    {e.item_id && <Link to={`/items/${e.item_id}`} className="feed-item"><span className="num quiet">#{e.item_id}</span> {titles.get(e.item_id) ?? ""}</Link>}
                  </div>
                  <div className="feed-msg">{st && <strong>{statusLabel(st)}. </strong>}{e.message}</div>
                </div>
                <div className="feed-meta">
                  {e.actor && e.actor !== "factory" && <span>{e.actor}</span>}
                  <span title={fmtDate(e.at)}><Ago iso={e.at} /></span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Page>
  );
}
