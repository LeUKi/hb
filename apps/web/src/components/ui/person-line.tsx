import type { ReactNode } from "react";
import { Avatar } from "./avatar";

/**
 * Someone found by name, as every by-name field shows them (转账's
 * recipient, an invitation, a link's 名义, 领取范围's 指定的人): face, 昵称
 * and @用户名, then whatever that field adds.
 */
export function PersonLine({
  person,
  children,
}: {
  person: { displayName: string; username: string; avatarUrl?: string | null };
  children?: ReactNode;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-2">
      <Avatar
        name={person.displayName}
        src={person.avatarUrl ?? null}
        size={20}
      />
      {person.displayName} @{person.username}
      {children}
    </p>
  );
}
