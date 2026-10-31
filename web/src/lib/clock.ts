// One shared ticker so every "4 min ago" on screen moves together without each owning a timer.
import { useSyncExternalStore } from "react";

let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer) timer = setInterval(() => { now = Date.now(); for (const s of subs) s(); }, 15_000);
  return () => { subs.delete(cb); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
}
export const useNow = () => useSyncExternalStore(subscribe, () => now);
