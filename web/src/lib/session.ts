import { createContext, useContext } from "react";
import type { SessionUser } from "./types";

/** canEdit: a member or admin. canApprove: may also open gates, review and nudge (the approverRole setting).
 *  refreshSession reads the session again, after something that may have changed a role. */
export type Me = { user: SessionUser; canEdit: boolean; canApprove: boolean; approverRole: "member" | "admin"; isAdmin: boolean; logout: () => void; refreshSession: () => void };
export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const m = useContext(MeContext);
  if (!m) throw new Error("useMe outside the signed-in shell");
  return m;
}
