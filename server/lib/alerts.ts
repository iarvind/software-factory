// Things a person should hear about that are not about any one work item.
import { emit } from "./events.ts";
import { notify, notifierConfigured } from "./notifier.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Someone signed in and waits on People; without a nudge they wait until an admin happens to look. Never throws. */
export async function pendingSignIn(u: { email: string; name: string | null }, link: string): Promise<void> {
  const who = u.name ? `${u.name} (${u.email})` : u.email;
  await emit({ type: "system", level: "warn", message: `${who} signed in and is waiting to be let in (People)`, data: { email: u.email, name: u.name }, actor: u.email })
    .catch((e) => console.warn(`could not record the pending sign-in of ${u.email}: ${message(e)}`));
  if (!notifierConfigured()) return;
  // Not awaited: a slow notifier must not hold up the sign-in redirect.
  notify({
    title: `New sign-in waiting: ${u.email}`,
    description: `${who} signed in to the factory and is waiting for an admin to let them in.\n${link}/people`,
    level: "warning", link: `${link}/people`, dedupeKey: `factory:pending:${u.email}`,
  }).catch((e) => console.warn(`notifier: could not tell admins about ${u.email} (${message(e)})`));
}
