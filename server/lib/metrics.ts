// The numbers everyone sees: how much is moving, how fast, how often it lands, what it costs.
// Four-keys-shaped where it makes sense (throughput, lead time, failure rate), plus the
// factory's own: fix rounds, cost per shipped change, where time is spent.
import { q, one } from "../db.ts";

export async function metrics(days = 30) {
  const since = `now() - interval '${Math.max(1, Math.min(365, days))} days'`;
  const byStatus = await q<{ status: string; n: number }>("select status, count(*)::int as n from work_items group by status");
  const totals = await one<{ created: number; done: number; failed: number; cancelled: number; cost: number; turns: number }>(
    `select count(*) filter (where created_at > ${since})::int as created,
            count(*) filter (where status = 'done' and finished_at > ${since})::int as done,
            count(*) filter (where status = 'failed' and finished_at > ${since})::int as failed,
            count(*) filter (where status = 'cancelled' and finished_at > ${since})::int as cancelled,
            coalesce(sum(cost_usd) filter (where created_at > ${since}), 0)::float as cost,
            coalesce(sum(turns) filter (where created_at > ${since}), 0)::int as turns
       from work_items`);
  const lead = await one<{ median_h: number | null; p90_h: number | null; mean_h: number | null }>(
    `select percentile_cont(0.5) within group (order by extract(epoch from (finished_at - created_at)) / 3600)::float as median_h,
            percentile_cont(0.9) within group (order by extract(epoch from (finished_at - created_at)) / 3600)::float as p90_h,
            avg(extract(epoch from (finished_at - created_at)) / 3600)::float as mean_h
       from work_items where status = 'done' and finished_at > ${since}`);
  const rounds = await one<{ fix: number | null; verify: number | null; cost_per_done: number | null; first_pass: number | null }>(
    `select avg(fix_rounds)::float as fix, avg(verify_rounds)::float as verify, avg(cost_usd)::float as cost_per_done,
            (count(*) filter (where fix_rounds = 0 and verify_rounds = 0))::float / nullif(count(*), 0) as first_pass
       from work_items where status = 'done' and finished_at > ${since}`);
  const waiting = await one<{ approvals: number; review: number; needs_info: number; blocked: number; oldest_wait_h: number | null }>(
    `select count(*) filter (where status = 'awaiting_approval')::int as approvals, count(*) filter (where status = 'review')::int as review,
            count(*) filter (where status = 'needs_info')::int as needs_info, count(*) filter (where status = 'blocked')::int as blocked,
            max(extract(epoch from (now() - updated_at)) / 3600) filter (where status in ('awaiting_approval', 'review', 'needs_info', 'blocked'))::float as oldest_wait_h
       from work_items`);
  const byDay = await q<{ day: string; created: number; done: number; failed: number; cost: number }>(
    `with d as (select generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day')::date as day)
     select to_char(d.day, 'YYYY-MM-DD') as day,
            (select count(*)::int from work_items w where w.created_at::date = d.day) as created,
            (select count(*)::int from work_items w where w.status = 'done' and w.finished_at::date = d.day) as done,
            (select count(*)::int from work_items w where w.status in ('failed', 'cancelled') and w.finished_at::date = d.day) as failed,
            (select coalesce(sum(r.cost_usd), 0)::float from runs r where r.finished_at::date = d.day) as cost
       from d order by d.day`);
  const byProject = await q<{ project_id: number; name: string; open: number; done: number; failed: number; cost: number; median_h: number | null }>(
    `select p.id as project_id, p.name,
            count(*) filter (where w.status not in ('done', 'failed', 'cancelled'))::int as open,
            count(*) filter (where w.status = 'done' and w.finished_at > ${since})::int as done,
            count(*) filter (where w.status in ('failed', 'cancelled') and w.finished_at > ${since})::int as failed,
            coalesce(sum(w.cost_usd) filter (where w.created_at > ${since}), 0)::float as cost,
            percentile_cont(0.5) within group (order by extract(epoch from (w.finished_at - w.created_at)) / 3600) filter (where w.status = 'done' and w.finished_at > ${since})::float as median_h
       from projects p left join work_items w on w.project_id = p.id group by p.id, p.name order by p.name`);
  const bySource = await q<{ kind: string; n: number; done: number }>(
    `select coalesce(s.kind, origin->>'kind', 'manual') as kind, count(*)::int as n, count(*) filter (where w.status = 'done')::int as done
       from work_items w left join sources s on s.id = w.source_id where w.created_at > ${since} group by 1 order by n desc`);
  const stages = await q<{ status: string; hours: number }>(
    `with t as (
       select item_id, data->>'status' as status, at, lead(at) over (partition by item_id order by id) as next_at
         from events where type = 'status' and data ? 'status' and at > ${since})
     select status, coalesce(sum(extract(epoch from (coalesce(next_at, now()) - at)) / 3600), 0)::float as hours
       from t where status is not null group by status order by hours desc`);
  const runs = await q<{ kind: string; n: number; ok: number; cost: number; avg_min: number | null; turns: number | null }>(
    `select kind, count(*)::int as n, count(*) filter (where status = 'succeeded')::int as ok, coalesce(sum(cost_usd), 0)::float as cost,
            avg(extract(epoch from (finished_at - started_at)) / 60)::float as avg_min, avg(turns)::float as turns
       from runs where created_at > ${since} group by kind order by n desc`);
  return { days, byStatus, totals, lead, rounds, waiting, byDay, byProject, bySource, stages, runs };
}

/** What runs that finished today (the database's day) cost; a run still going counts once it ends. */
export async function spentToday(): Promise<{ total: number; byProject: Array<{ project_id: number; name: string; usd: number }> }> {
  const rows = await q<{ project_id: number | null; name: string | null; usd: number }>(
    `select w.project_id, p.name, sum(r.cost_usd)::float as usd
       from runs r join work_items w on w.id = r.item_id left join projects p on p.id = w.project_id
      where r.finished_at >= date_trunc('day', now()) and r.cost_usd is not null
      group by w.project_id, p.name order by usd desc`);
  return {
    total: rows.reduce((s, r) => s + r.usd, 0),
    byProject: rows.filter((r) => r.project_id != null).map((r) => ({ project_id: Number(r.project_id), name: r.name ?? `#${r.project_id}`, usd: r.usd })),
  };
}
