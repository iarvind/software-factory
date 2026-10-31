import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, invalidate, post, put, setForbiddenHandler, setPendingHandler, setUnauthorizedHandler, useApi } from "./lib/api";
import { refreshItemSoon, startLive, useLive, useLiveHello, useLiveState } from "./lib/live";
import { MeContext, useMe, type Me } from "./lib/session";
import type { BoardData, SessionInfo } from "./lib/types";
import { Avatar, Button, Input, Sheet, Toaster, attempt } from "./components/ui";
import { Icon } from "./components/icons";
import Board from "./pages/Board";
import Inbox from "./pages/Inbox";
import ItemPage from "./pages/Item";
import Projects from "./pages/Projects";
import ProjectPage from "./pages/Project";
import ProjectEdit from "./pages/ProjectEdit";
import Sources from "./pages/Sources";
import People from "./pages/People";
import MetricsPage from "./pages/Metrics";
import Book from "./pages/Book";
import SettingsPage from "./pages/Settings";
import Activity from "./pages/Activity";

const NAV = [
  { to: "/", label: "Board", icon: "board" },
  { to: "/inbox", label: "Inbox", icon: "inbox" },
  { to: "/projects", label: "Projects", icon: "projects" },
  { to: "/sources", label: "Sources", icon: "sources" },
  { to: "/people", label: "People", icon: "people" },
  { to: "/metrics", label: "Metrics", icon: "metrics" },
  { to: "/book", label: "Book", icon: "book" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [failed, setFailed] = useState("");
  const refresh = useCallback(async () => {
    try { setSession(await api<SessionInfo>("/api/session")); setFailed(""); }
    catch (e) { setFailed(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => { void refresh(); });
    setPendingHandler(() => { void refresh(); });
    setForbiddenHandler(() => { void refresh(); });
    void refresh();
    // A role or the approver setting can change while the tab sits in the background.
    let lastFocus = 0;
    const onFocus = () => { if (Date.now() - lastFocus > 5000) { lastFocus = Date.now(); void refresh(); } };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  const logout = useCallback(async () => {
    try { await post("/api/logout"); } catch { /* the cookie is cleared either way */ }
    invalidate();
    await refresh();
  }, [refresh]);

  if (!session) {
    if (!failed) return null;
    return <div className="login"><div className="login-box"><BrandMark /><p className="error" role="alert">The factory did not answer: {failed}</p><Button onClick={refresh}>Try again</Button></div></div>;
  }
  if (session.user?.role === "pending") return <Pending email={session.user.email} onLogout={logout} onCheck={refresh} />;
  if (!session.ok || !session.user) return <Login session={session} onDone={refresh} />;
  return <SignedIn session={session} logout={logout} refreshSession={refresh} />;
}

function SignedIn({ session, logout, refreshSession }: { session: SessionInfo; logout: () => void; refreshSession: () => void }) {
  const user = session.user!;
  // Keyed on the values, so reading the same session again does not re-render every page.
  const me = useMemo<Me>(() => {
    const canEdit = user.role === "admin" || user.role === "member";
    return { user, canEdit, canApprove: canEdit && Boolean(user.canApprove), approverRole: session.approverRole ?? "member", isAdmin: user.role === "admin", logout, refreshSession };
  }, [JSON.stringify(user), session.approverRole, logout, refreshSession]);
  // The same element every time, so a session re-read that changes nothing does not re-render the pages.
  const shell = useMemo(() => <Shell />, []);
  return <MeContext.Provider value={me}>{shell}</MeContext.Provider>;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 18v-6l4-3v3l4-3v3l4-3v9z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg></span>;
}

/** What the Google callback left in the address bar, read once and cleared. */
function loginNotice(): { text: string; bad: boolean } {
  const params = new URLSearchParams(location.search);
  const v = params.get("login");
  if (v == null) return { text: "", bad: false };
  history.replaceState(null, "", location.pathname);
  if (v === "cancelled") return { text: "Sign-in was cancelled. Try again when you are ready.", bad: false };
  if (v.startsWith("denied:")) return { text: `${v.slice(7)} is not allowed in. Ask an admin to let that account in, or sign in with another.`, bad: true };
  if (v.startsWith("error:")) return { text: v.slice(6), bad: true };
  return { text: "", bad: false };
}

function Login({ session, onDone }: { session: SessionInfo; onDone: () => void }) {
  const [notice] = useState(loginNotice);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const { google, dev } = session.methods;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true); setErr("");
    try { await post("/api/auth/dev", { email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); onDone(); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  };
  return (
    <div className="login">
      <div className="login-box">
        <BrandMark />
        <h1 className="login-name">Software Factory</h1>
        <p className="quiet">Requests in, shipped changes out. Sign in to see the floor.</p>
        {notice.text && <p className={notice.bad ? "error" : "quiet"} role={notice.bad ? "alert" : "status"}>{notice.text}</p>}
        {google && <a className="btn primary block" href="/api/auth/google">Continue with Google</a>}
        {google && dev && <div className="login-or">or, on this machine only</div>}
        {dev && (
          <form onSubmit={submit} className="login-form">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" autoComplete="email" autoFocus={!google} required />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" autoComplete="name" />
            <Button type="submit" block variant={google ? "secondary" : "primary"} disabled={busy || !email}>Sign in for development</Button>
          </form>
        )}
        {!google && !dev && <p className="quiet">No sign-in is configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, or DEV_LOGIN=1 for local use.</p>}
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </div>
  );
}

function Pending({ email, onLogout, onCheck }: { email: string; onLogout: () => void; onCheck: () => void }) {
  const check = useRef(onCheck);
  check.current = onCheck;
  useEffect(() => { const t = setInterval(() => check.current(), 20_000); return () => clearInterval(t); }, []);
  return (
    <div className="login">
      <div className="login-box">
        <BrandMark />
        <h1 className="login-name">Waiting to be let in</h1>
        <p>You are signed in as <strong>{email}</strong>, but this account has not been given a role yet.</p>
        <p className="quiet">An admin lets new people in from People in the factory. Ask one to let you in as a member (to send requests and approve work) or a viewer (to watch). This page opens the board once they have.</p>
        <Button block onClick={onCheck}>Check again</Button>
        <Button block variant="ghost" onClick={onLogout}>Log out</Button>
      </div>
    </div>
  );
}

// ---------- the shell ----------

const REFRESH_TYPES = new Set(["status", "run", "approval", "system"]);
const ITEM_TYPES = new Set(["status", "run", "approval", "feedback", "post", "git", "note", "verify", "error", "system"]);
/** A commit or a status change can change the diff too. */
const DEEP_TYPES = new Set(["status", "git"]);

/** Live events become cache refreshes: the board, approvals and activity on any status, run, approval or system
 *  event; sources on system events (their polls report there); the item on anything that changes its page. */
function useLiveRefresh() {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const soon = useCallback((key: string, ms: number, ...prefixes: string[]) => {
    if (timers.current.has(key)) return;
    timers.current.set(key, setTimeout(() => { timers.current.delete(key); invalidate(...prefixes); }, ms));
  }, []);
  const refreshBoard = useCallback(() => soon("board", 400, "/api/board", "/api/approvals", "/api/items?", "/api/status", "/api/activity"), [soon]);
  useEffect(() => startLive(), []);
  useLive((e) => {
    if (REFRESH_TYPES.has(e.type)) refreshBoard();
    if (e.item_id && ITEM_TYPES.has(e.type)) refreshItemSoon(e.item_id, DEEP_TYPES.has(e.type));
    if (e.type === "system") {
      soon("sources", 1000, "/api/sources");
      if (/paused|resumed/.test(e.message ?? "")) soon("settings", 400, "/api/settings");
    }
  });
  useLiveHello(refreshBoard);
}

function LiveIndicator({ board }: { board: BoardData | undefined }) {
  const state = useLiveState();
  const n = board?.active.length ?? 0;
  const label = state === "down" ? "Offline, retrying" : state !== "open" ? "Connecting…" : board?.paused ? "Paused" : n ? `${n} running` : "Idle";
  const family = state !== "open" ? "idle" : board?.paused ? "wait" : n ? "work" : "done";
  return (
    <div className="live" role="status" aria-live="polite">
      <span className={`lamp f-${family} ${n && state === "open" && !board?.paused ? "live" : ""}`} aria-hidden="true" />
      <span className="num">{label}</span>
    </div>
  );
}

function Banners({ board, isAdmin }: { board: BoardData | undefined; isAdmin: boolean }) {
  if (!board) return null;
  const resume = () => attempt(async () => { await put("/api/settings", { paused: false }); invalidate("/api/board", "/api/settings"); }, "The factory is running again");
  return (
    <>
      {board.paused && (
        <div className="topbanner wait" role="status">
          <span className="lamp f-wait" aria-hidden="true" />
          <span className="grow"><strong>The factory is paused.</strong> Nothing new starts; runs already going finish their current step.</span>
          {isAdmin && <Button size="sm" variant="secondary" onClick={resume}>Resume</Button>}
        </div>
      )}
      {!board.paused && board.held && (
        <div className="topbanner wait" role="status">
          <span className="lamp f-wait" aria-hidden="true" />
          <span className="grow"><strong>Holding new runs:</strong> {board.held}. They start again when the window resets.</span>
        </div>
      )}
    </>
  );
}

function Shell() {
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const { data: board } = useApi<BoardData>("/api/board");
  useLiveRefresh();
  useEffect(() => { setMenu(false); window.scrollTo({ top: 0 }); }, [loc.pathname]);
  return (
    <MeShell board={board} menu={menu} setMenu={setMenu} path={loc.pathname} />
  );
}

function MeShell({ board, menu, setMenu, path }: { board: BoardData | undefined; menu: boolean; setMenu: (v: boolean) => void; path: string }) {
  const me = useMe();
  const waiting = board ? board.items.filter((i) => i.status === "awaiting_approval" || i.status === "needs_info" || i.status === "review").length : 0;
  const nav = (
    <nav className="nav" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === "/"}>
          <Icon name={n.icon} /><span className="grow">{n.label}</span>
          {n.to === "/" && waiting ? <span className="badge num" title={`${waiting} waiting on a person`}>{waiting}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
  const user = (
    <div className="side-user">
      <Avatar name={me.user.name || me.user.email} picture={me.user.picture} />
      <div className="grow">
        <div className="side-user-name">{me.user.name || me.user.email}</div>
        <div className="side-user-role">{me.user.role}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={me.logout}>Log out</Button>
    </div>
  );
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><BrandMark />Factory</div>
        <LiveIndicator board={board} />
        {nav}
        {user}
      </aside>
      <header className="topbar">
        <div className="brand"><BrandMark />Factory</div>
        <LiveIndicator board={board} />
        <button type="button" className="iconbtn" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu(true)}><Icon name="menu" size={20} /></button>
      </header>
      <main className="main" id="main">
        <Banners board={board} isAdmin={me.isAdmin} />
        <div key={path.split("/")[1]}>
          <Routes>
            <Route path="/" element={<Board />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/items/:id" element={<ItemPage />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<ProjectEdit />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/edit" element={<ProjectEdit />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/people" element={<People />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/book" element={<Book />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </main>
      <Sheet open={menu} onClose={() => setMenu(false)} title="Factory">
        <div className="mobile-nav">{nav}{user}</div>
      </Sheet>
      <Toaster />
    </div>
  );
}


function NotFound() {
  return <div className="page"><div className="empty"><strong>Nothing here</strong><span>That address does not match a page. The board is the place to start.</span><NavLink className="btn secondary" to="/">Open the board</NavLink></div></div>;
}
