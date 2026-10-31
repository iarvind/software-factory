import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { del, invalidate, post, useApi } from "../lib/api";
import { splitList } from "../lib/format";
import { useMe } from "../lib/session";
import type { BoardData, Note } from "../lib/types";
import { Ago, Button, Empty, ErrorNote, Field, Group, Input, Loading, Page, Section, Select, Textarea, attempt } from "../components/ui";

export default function Book() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const project = params.get("project") ?? "";
  const { data: board } = useApi<BoardData>("/api/board");
  const { data: notes, error, reload } = useApi<Note[]>(project ? `/api/projects/${project}/notes` : "/api/notes");
  const names = new Map((board?.projects ?? []).map((p) => [p.id, p.name]));
  return (
    <Page title="Book" subtitle="What the factory has learned about each repository. Agents write a note after every job, and every new run reads the latest ones, so a correction made once sticks."
      aside={<Select aria-label="Filter by project" value={project} onChange={(e) => { const p = new URLSearchParams(params); if (e.target.value) p.set("project", e.target.value); else p.delete("project"); setParams(p, { replace: true }); }}>
        <option value="">All projects</option>
        {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>}>
      {me.canEdit && <Section first title="Add a note"><NoteComposer projectId={project ? Number(project) : null} choose /></Section>}
      <Section first={!me.canEdit} title="Notes" hint={notes ? `${notes.length}` : undefined}>
        {error && <ErrorNote error={error} onRetry={reload} />}
        {!notes && !error && <Loading />}
        {notes && !notes.length && <Empty title="The book is empty" hint="Notes appear after jobs finish, or when someone writes down a convention the agents keep missing." />}
        {notes && notes.length > 0 && <Group>{notes.map((n) => <NoteRow key={n.id} n={n} project={n.project_id ? names.get(n.project_id) : undefined} />)}</Group>}
      </Section>
    </Page>
  );
}

export function NoteRow({ n, project }: { n: Note; project?: string }) {
  const me = useMe();
  const remove = () => { if (confirm("Delete this note? Agents will no longer read it.")) void attempt(async () => { await del(`/api/notes/${n.id}`); invalidate("/api/notes", "/api/projects/"); }, "Note deleted"); };
  return (
    <div className="row note">
      <div className="row-main">
        <div className="note-body plain">{n.body}</div>
        <div className="row-sub inline-tight">
          {project && n.project_id && <Link to={`/projects/${n.project_id}`}>{project}</Link>}
          <span>{n.author}</span>
          <Ago iso={n.created_at} />
          {n.item_id && <Link to={`/items/${n.item_id}`} className="num">from #{n.item_id}</Link>}
          {n.tags.map((t) => <span key={t} className="chip">{t}</span>)}
        </div>
      </div>
      {me.canEdit && <div className="row-trailing"><Button size="sm" variant="ghost" onClick={remove} aria-label="Delete note">Delete</Button></div>}
    </div>
  );
}

export function NoteComposer({ projectId, choose }: { projectId: number | null; choose?: boolean }) {
  const { data: board } = useApi<BoardData>("/api/board");
  const [pid, setPid] = useState(projectId ? String(projectId) : "");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const target = choose ? pid || (projectId ? String(projectId) : "") : String(projectId ?? "");
  const ok = Boolean(target) && body.trim().length >= 3;
  const save = async () => {
    setBusy(true);
    const done = await attempt(async () => {
      await post(`/api/projects/${target}/notes`, { body: body.trim(), tags: splitList(tags).map((t) => t.slice(0, 30)).slice(0, 5) });
      invalidate("/api/notes", "/api/projects/");
    }, "Note added to the book");
    setBusy(false);
    if (done) { setBody(""); setTags(""); }
  };
  return (
    <form className="note-form" onSubmit={(e) => { e.preventDefault(); if (ok) void save(); }}>
      <Field label="Note" hint="Two to five sentences for the next agent: what was not obvious, which command or convention matters."><Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></Field>
      <div className="grid3">
        {choose && (
          <Field label="Project" required>
            <Select value={target} onChange={(e) => setPid(e.target.value)}>
              <option value="">Choose a project</option>
              {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Tags" hint="Up to five, comma separated"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="testing, migrations" /></Field>
        <div className="field end"><Button type="submit" disabled={!ok || busy}>Add note</Button></div>
      </div>
    </form>
  );
}
