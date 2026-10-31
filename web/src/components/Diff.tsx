// The change as a unified diff: one collapsible block per file, hunks with line numbers.
import { useEffect, useMemo, useState } from "react";
import { apiText, useApi } from "../lib/api";
import { plural } from "../lib/format";
import { Button, Empty, ErrorNote, Loading, Sheet, CopyButton } from "./ui";

type Line = { t: "+" | "-" | " " | "\\"; text: string; a: number | null; b: number | null };
type Hunk = { header: string; lines: Line[] };
type FileDiff = { path: string; oldPath: string | null; change: "added" | "deleted" | "renamed" | "modified"; binary: boolean; hunks: Hunk[]; add: number; del: number };

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let h: Hunk | null = null;
  let a = 0, b = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      f = { path: m?.[2] ?? line.slice(11), oldPath: m?.[1] ?? null, change: "modified", binary: false, hunks: [], add: 0, del: 0 };
      files.push(f); h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith("new file mode")) f.change = "added";
      else if (line.startsWith("deleted file mode")) f.change = "deleted";
      else if (line.startsWith("rename from ")) { f.change = "renamed"; f.oldPath = line.slice(12); }
      else if (line.startsWith("rename to ")) f.path = line.slice(10);
      else if (line.startsWith("Binary files")) f.binary = true;
      else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) f.path = line.slice(4).replace(/^b\//, "");
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      a = m ? Number(m[1]) : 0; b = m ? Number(m[2]) : 0;
      h = { header: line, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const c = line[0];
    if (c === "+") { h.lines.push({ t: "+", text: line.slice(1), a: null, b: b++ }); f.add++; }
    else if (c === "-") { h.lines.push({ t: "-", text: line.slice(1), a: a++, b: null }); f.del++; }
    else if (c === "\\") h.lines.push({ t: "\\", text: line, a: null, b: null });
    else if (c === " ") h.lines.push({ t: " ", text: line.slice(1), a: a++, b: b++ });
  }
  return files;
}

type DiffData = { stat: string; patch: string; truncated: boolean; available: boolean; error?: string };

export function DiffView({ itemId, hasWorktree }: { itemId: number; hasWorktree: boolean }) {
  const { data, error, loading, reload } = useApi<DiffData>(`/api/items/${itemId}/diff`);
  const files = useMemo(() => (data?.patch ? parsePatch(data.patch.replace(/\n$/, "")) : []), [data]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (loading || !data) return <Loading label="Reading the change" />;
  if (!data.available) return <Empty title="No change to show" hint={data.error ?? (hasWorktree ? "The branch has no commits beyond its base yet." : "Nothing has been built yet, or the worktree was cleaned up after the item finished.")} action={<Button size="sm" variant="secondary" onClick={reload}>Refresh</Button>} />;
  if (!files.length) return <Empty title="No differences" hint="The branch matches its base." action={<Button size="sm" variant="secondary" onClick={reload}>Check again</Button>} />;
  const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
  const lines = files.reduce((n, f) => n + f.hunks.reduce((m, hk) => m + hk.lines.length, 0), 0);
  const defaultOpen = allOpen ?? (files.length <= 15 && lines < 4000);
  return (
    <div className="diff">
      <div className="diff-summary">
        <span><strong>{plural(files.length, "file")} changed</strong> <span className="add num">+{add}</span> <span className="del num">−{del}</span></span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => setAllOpen(!defaultOpen)}>{defaultOpen ? "Collapse all" : "Expand all"}</Button>
        <Button size="sm" variant="ghost" onClick={reload}>Refresh</Button>
      </div>
      {data.truncated && <p className="banner wait">The diff is too large to show in full; what follows is cut short.</p>}
      {data.stat && <details className="diff-stat"><summary>git diff --stat</summary><pre className="code">{data.stat}</pre></details>}
      {/* Expand or collapse all remounts the blocks with the new starting state. */}
      {files.map((f) => <FileBlock key={`${f.path}-${allOpen}`} f={f} initialOpen={defaultOpen} onOpen={() => setOpenFile(f.path)} />)}
      <FileSheet itemId={itemId} path={openFile} onClose={() => setOpenFile(null)} />
    </div>
  );
}

const CHANGE_LABEL = { added: "new", deleted: "deleted", renamed: "renamed", modified: "" } as const;

/** The hunk rows exist only while the file is open: a large patch collapsed costs a summary line per file. */
function FileBlock({ f, initialOpen, onOpen }: { f: FileDiff; initialOpen: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details className="diff-file" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="mono diff-path">{f.change === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
        {CHANGE_LABEL[f.change] && <span className="tag">{CHANGE_LABEL[f.change]}</span>}
        <span className="grow" />
        <span className="add num">+{f.add}</span><span className="del num">−{f.del}</span>
        {f.change !== "deleted" && <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); onOpen(); }}>Open file</Button>}
      </summary>
      {!open ? null : f.binary ? <p className="quiet diff-note">Binary file</p> : (
        <table className="diff-table">
          <tbody>
            {f.hunks.map((hk, i) => (
              <HunkRows key={i} hk={hk} />
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function HunkRows({ hk }: { hk: Hunk }) {
  return (
    <>
      <tr className="hunk"><td colSpan={3}>{hk.header}</td></tr>
      {hk.lines.map((l, j) => (
        <tr key={j} className={l.t === "+" ? "ins" : l.t === "-" ? "rem" : l.t === "\\" ? "meta" : ""}>
          <td className="ln num">{l.a ?? ""}</td>
          <td className="ln num">{l.b ?? ""}</td>
          <td className="src"><span className="sign" aria-hidden="true">{l.t === "\\" ? "" : l.t}</span>{l.t === "+" ? <span className="sr-only">added: </span> : l.t === "-" ? <span className="sr-only">removed: </span> : null}{l.text}</td>
        </tr>
      ))}
    </>
  );
}

function FileSheet({ itemId, path, onClose }: { itemId: number; path: string | null; onClose: () => void }) {
  const [state, setState] = useState<{ path: string; text?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!path) { setState(null); return; }
    let live = true;
    setState({ path });
    apiText(`/api/items/${itemId}/file?path=${encodeURIComponent(path)}`).then(
      (text) => { if (live) setState({ path, text }); },
      (e) => { if (live) setState({ path, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [itemId, path]);
  if (!path) return null;
  return (
    <Sheet open onClose={onClose} title={<span className="mono">{path}</span>} wide
      footer={state?.text != null ? <CopyButton text={state.text} label="Copy file" /> : undefined}>
      {state?.error ? <p className="error">{state.error}</p> : state?.text == null ? <Loading /> : <pre className="code file">{state.text}</pre>}
    </Sheet>
  );
}
