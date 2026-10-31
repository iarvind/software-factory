// One stroke weight, one 16-unit grid, so the glyphs sit together as a set.
import type { ReactNode } from "react";

function Svg({ children, size = 16, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {label && <title>{label}</title>}
      {children}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  // navigation
  board: <><rect x="2" y="2.5" width="3.2" height="11" rx="1" /><rect x="6.4" y="2.5" width="3.2" height="7" rx="1" /><rect x="10.8" y="2.5" width="3.2" height="9" rx="1" /></>,
  inbox: <><path d="M2.5 9.5l1.6-6h7.8l1.6 6" /><path d="M2.5 9.5v3.5h11V9.5h-3.2l-.8 1.5H6.5l-.8-1.5z" /></>,
  projects: <><path d="M2.5 4.5v8h11v-6.5H8L6.5 4.5z" /></>,
  sources: <><path d="M8 13.5V8" /><path d="M5 10.5a4 4 0 1 1 6 0" /><path d="M3.2 12.3a6.5 6.5 0 1 1 9.6 0" /></>,
  people: <><circle cx="6" cy="5.5" r="2.3" /><path d="M2 13c.5-2.3 2-3.5 4-3.5s3.5 1.2 4 3.5" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M12 9.8c1 .5 1.7 1.6 2 3.2" /></>,
  metrics: <><path d="M2.5 13.5h11" /><path d="M4 11V8M7 11V4.5M10 11V7M13 11V3" /></>,
  book: <><path d="M3 3h4a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 0 7 12H3z" /><path d="M13 3H9.5A1 1 0 0 0 8.5 4v9.5" /><path d="M13 3v9H10" /></>,
  activity: <><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></>,
  menu: <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></>,
  plus: <><path d="M8 3v10M3 8h10" /></>,
  // origins
  manual: <><path d="M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z" /><path d="M9 4.3l2.7 2.7" /></>,
  api: <><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" /></>,
  slack: <><path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11" /></>,
  jira: <><path d="M8 2l6 6-6 6-6-6z" /><path d="M8 5.5L10.5 8 8 10.5 5.5 8z" /></>,
  github: <><circle cx="4.5" cy="3.8" r="1.5" /><circle cx="4.5" cy="12.2" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5.3v5.4M11.5 7c0 2.5-3 2.5-6.2 4" /></>,
  linear: <><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6M2.8 9.6l3.6 3.6" /></>,
  schedule: <><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.2 1.4" /></>,
  watch: <><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></>,
  webhook: <><path d="M6.5 5.2A2.5 2.5 0 1 1 9 8.5L11 12" /><path d="M4 9.5a2.5 2.5 0 1 0 3 3.9h4.5" /><circle cx="12" cy="13.4" r=".4" /></>,
  telegram: <><path d="M14 2.5L1.8 7.2l4 1.5L12 4.5 7.3 9.7l5 3.8z" /></>,
  // timeline
  status: <><circle cx="8" cy="8" r="3" /></>,
  text: <><path d="M2.5 3.5h11v7H7l-3 2.5v-2.5H2.5z" /></>,
  tool: <><path d="M10.2 2.4a3 3 0 0 0-3.6 3.9L2.5 10.4a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.9-3.6l-1.8 1.8-1.7-.4-.4-1.7z" /></>,
  verify: <><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z" /><path d="M5.6 8l1.7 1.7 3.2-3.4" /></>,
  git: <><circle cx="4.5" cy="3.8" r="1.5" /><circle cx="4.5" cy="12.2" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5.3v5.4M11.5 6.5c0-2-1.5-2.7-3.5-2.7H6" /></>,
  post: <><path d="M2.5 6.5v3h2l5 3v-9l-5 3z" /><path d="M12 5.5a3.5 3.5 0 0 1 0 5" /></>,
  feedback: <><path d="M13.5 3.5h-11v7H5v2.5l3-2.5h5.5z" /><path d="M5.5 6.2h5M5.5 8.2h3" /></>,
  approval: <><path d="M3 13.5V5.5M13 13.5V5.5M3 5.5h10M3 9h10" /><path d="M6.5 2.5h3" /></>,
  note: <><path d="M4 2.5h8v11l-4-2.5-4 2.5z" /></>,
  error: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></>,
  log: <><path d="M3 5h10M3 8h10M3 11h6" /></>,
  system: <><circle cx="8" cy="8" r="2" /><path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14" /></>,
  run: <><path d="M5 3.2v9.6L12.5 8z" /></>,
  file: <><path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" /></>,
  link: <><path d="M6.5 9.5l3-3M7 4.8l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" /></>,
  pause: <><path d="M5.5 3.5v9M10.5 3.5v9" /></>,
  play: <><path d="M5 3.2v9.6L12.5 8z" /></>,
};

export type IconName = keyof typeof PATHS;
export function Icon({ name, size, label }: { name: string; size?: number; label?: string }) {
  return <Svg size={size} label={label}>{PATHS[name] ?? PATHS.status}</Svg>;
}
