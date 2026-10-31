// Telling people what is going on, where they are: a Slack thread, a Jira comment, a GitHub
// issue, Telegram through the notifier, and always the item's own timeline. Each origin kind
// registers a poster; the factory calls postStatus and does not care which.
import { q } from "../db.ts";
import { emit } from "./events.ts";
import type { Item } from "./items.ts";
import { appLink } from "./auth.ts";
import { notify, notifierConfigured } from "./notifier.ts";

export type PostButtons = Array<{ text: string; data: string } | { text: string; url: string }>;
export type PostMessage = { text: string; level?: "info" | "success" | "warning" | "error"; buttons?: PostButtons; title?: string; important?: boolean };
export type Poster = (item: Item, msg: PostMessage) => Promise<{ ref?: unknown } | void>;

const posters = new Map<string, Poster>();
export function registerPoster(kind: string, p: Poster): void { posters.set(kind, p); }
export const hasPoster = (kind: string) => posters.has(kind);

export const itemLink = (id: number) => `${appLink()}/items/${id}`;

/** Posts to the item's origin (if that kind has a poster) and to Telegram (for anything important); records every attempt. */
export async function postStatus(item: Item, msg: PostMessage): Promise<void> {
  const kind = item.origin?.kind ?? "manual";
  const poster = posters.get(kind);
  if (poster) {
    try {
      const r = await poster(item, msg);
      await q("insert into posts (item_id, target, ref, body, ok) values ($1, $2, $3, $4, true)", [item.id, kind, JSON.stringify(r?.ref ?? null), msg.text.slice(0, 8000)]);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await q("insert into posts (item_id, target, body, ok, error) values ($1, $2, $3, false, $4)", [item.id, kind, msg.text.slice(0, 8000), error.slice(0, 2000)]);
      await emit({ itemId: item.id, type: "post", level: "warn", message: `could not post to ${kind}: ${error}` });
    }
  }
  if (msg.important && notifierConfigured()) {
    try {
      const r = await notify({
        title: msg.title ?? `#${item.id} ${item.title}`.slice(0, 200), description: msg.text.slice(0, 8000), level: msg.level ?? "info", compact: true, link: itemLink(item.id),
        buttons: msg.buttons?.length ? [msg.buttons.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, data: b.data })).slice(0, 4), [{ text: "Open", url: itemLink(item.id) }]] : [[{ text: "Open", url: itemLink(item.id) }]],
        dedupeKey: `factory:${item.id}:${msg.text.slice(0, 40)}`,
      });
      await q("insert into posts (item_id, target, ref, body, ok) values ($1, 'telegram', $2, $3, true)", [item.id, JSON.stringify({ id: r.id }), msg.text.slice(0, 8000)]);
    } catch (e) {
      await q("insert into posts (item_id, target, body, ok, error) values ($1, 'telegram', $2, false, $3)", [item.id, msg.text.slice(0, 8000), (e instanceof Error ? e.message : String(e)).slice(0, 2000)]);
    }
  }
  await emit({ itemId: item.id, type: "post", message: msg.text.length > 400 ? `${msg.text.slice(0, 400)}…` : msg.text, data: { target: poster ? kind : null, telegram: Boolean(msg.important && notifierConfigured()) } });
}

export const postsFor = (itemId: number) => q<{ id: number; target: string; ref: unknown; body: string | null; ok: boolean; error: string | null; created_at: string }>("select * from posts where item_id = $1 order by id", [itemId]);
