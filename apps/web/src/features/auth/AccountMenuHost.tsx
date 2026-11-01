import { createContext, useContext } from "react";

export const AccountMenuHostContext = createContext<((host: HTMLDivElement | null) => void) | null>(
  null,
);

/** Lets a workspace host the existing account menu without duplicating session state. */
export function AccountMenuHost() {
  const registerHost = useContext(AccountMenuHostContext);
  return <div className="canvas-sidebar-account" ref={registerHost ?? undefined} />;
}
