import { del, invalidate, patch, useApi } from "../lib/api";
import { useMe } from "../lib/session";
import type { Role, UserRow } from "../lib/types";
import { Ago, Avatar, Button, Empty, ErrorNote, Group, Loading, Page, Section, Select, attempt } from "../components/ui";

const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including people, settings and deleting things.",
  member: "Sends requests, approves gates, reviews, edits projects and sources.",
  viewer: "Sees everything, changes nothing.",
  pending: "Signed in, waiting to be let in.",
};

export default function People() {
  const me = useMe();
  const { data: users, error, reload } = useApi<UserRow[]>("/api/users");
  const pending = (users ?? []).filter((u) => u.role === "pending" && !u.disabled);
  const rest = (users ?? []).filter((u) => u.role !== "pending" || u.disabled);
  const setRole = (u: UserRow, role: Role) => attempt(async () => { await patch(`/api/users/${u.id}`, { role }); invalidate("/api/users"); }, `${u.name || u.email} is now ${role === "admin" ? "an admin" : `a ${role}`}`);
  const setDisabled = (u: UserRow, disabled: boolean) => {
    if (disabled && !confirm(`Disable ${u.email}? They are signed out everywhere and cannot sign in again until enabled.`)) return;
    void attempt(async () => { await patch(`/api/users/${u.id}`, { disabled }); invalidate("/api/users"); }, disabled ? "Disabled and signed out" : "Enabled");
  };
  const remove = (u: UserRow) => {
    if (!confirm(`Remove ${u.email}? Their requests stay, without a requester account.`)) return;
    void attempt(async () => { await del(`/api/users/${u.id}`); invalidate("/api/users"); }, "Removed");
  };
  return (
    <Page title="People" subtitle={me.isAdmin ? "Who can sign in, and what each person may do." : "Who can sign in, and what each person may do. Admins change roles."}>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!users && !error && <Loading />}
      {pending.length > 0 && (
        <Section first title="Waiting to be let in" hint={`${pending.length}`}>
          <Group>
            {pending.map((u) => (
              <div className="row" key={u.id}>
                <Avatar name={u.name || u.email} picture={u.picture} size={36} />
                <div className="row-main"><div className="row-title">{u.name || u.email}</div><div className="row-sub">{u.email}, signed in <Ago iso={u.last_seen_at ?? u.created_at} /></div></div>
                {me.isAdmin
                  ? <div className="row-trailing"><Button size="sm" variant="secondary" onClick={() => setRole(u, "viewer")}>Viewer</Button><Button size="sm" onClick={() => setRole(u, "member")}>Let in as member</Button></div>
                  : <div className="row-trailing quiet">an admin decides</div>}
              </div>
            ))}
          </Group>
          <p className="quiet group-note">Admins are told on Telegram when someone new signs in.</p>
        </Section>
      )}
      {users && (
        <Section first={!pending.length} title="Everyone" hint={`${rest.length}`}>
          {!rest.length ? <Empty title="Nobody else yet" /> : (
            <Group>
              {rest.map((u) => (
                <div className={`row ${u.disabled ? "disabled-row" : ""}`} key={u.id}>
                  <Avatar name={u.name || u.email} picture={u.picture} size={36} />
                  <div className="row-main">
                    <div className="row-title">{u.name || u.email}{u.me && <span className="quiet"> (you)</span>}{u.disabled && <span className="tag bad">disabled</span>}</div>
                    <div className="row-sub">{u.email}. {u.last_seen_at ? <>Seen <Ago iso={u.last_seen_at} /></> : "Never seen"}. <span className="num">{u.items}</span> request{u.items === 1 ? "" : "s"}.</div>
                  </div>
                  <div className="row-trailing">
                    {me.isAdmin && !u.me ? (
                      <>
                        <Select aria-label={`Role of ${u.email}`} value={u.role} onChange={(e) => setRole(u, e.target.value as Role)} className="sm" title={ROLE_HELP[u.role]}>
                          {(["admin", "member", "viewer", "pending"] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
                        </Select>
                        <Button size="sm" variant="ghost" onClick={() => setDisabled(u, !u.disabled)}>{u.disabled ? "Enable" : "Disable"}</Button>
                        <Button size="sm" variant="danger" onClick={() => remove(u)}>Remove</Button>
                      </>
                    ) : <span className="role" title={ROLE_HELP[u.role]}>{u.role}</span>}
                  </div>
                </div>
              ))}
            </Group>
          )}
        </Section>
      )}
      <Section title="Roles">
        <dl className="facts roles">
          {(["admin", "member", "viewer", "pending"] as Role[]).map((r) => <div key={r}><dt>{r}</dt><dd>{ROLE_HELP[r]}</dd></div>)}
        </dl>
      </Section>
    </Page>
  );
}
