import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  type MyPointsKey,
  statusWords,
  useMyPointsKeys,
} from "../../lib/points";
import { clockLabel } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { PageSection, Panel } from "../page/page";
import { PointsMark } from "../ui/points-mark";
import { ListItem, Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { statusTones } from "../views/points-view";

// 我的 → 三方积分密钥 (docs/third-party-points-design.md §8): where one has
// pasted a key, at a glance. Changing or removing one stays on its system's
// page (/points/:id, 我的密钥), where removing says what it ends.

function KeyRow({ item }: { item: MyPointsKey }) {
  const { system, key } = item;
  const online = system.status === "online";
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <Link
          to="/points/$id"
          params={{ id: system.id }}
          hash="my-key"
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <PointsMark
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">
                {system.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-3">
                {system.host}
              </span>
            </span>
            <span className="truncate text-xs text-ink-3 tabular-nums">
              {key.status === "ok"
                ? `从 @${key.accountUsername ?? "?"} 的账户扣 · ${clockLabel(key.checkedAt)} 核对`
                : `${system.host} 上次说这把密钥无效`}
            </span>
          </span>
          {!online ? (
            <StatusChip tone={statusTones[system.status] ?? "neutral"}>
              {statusWords[system.status]}
            </StatusChip>
          ) : key.status === "invalid" ? (
            <StatusChip tone="danger">无效</StatusChip>
          ) : null}
          <ChevronRight
            className="size-4 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </Link>
      </Squircle>
    </ListItem>
  );
}

/** Only for those who have pasted one: most never see it. */
export function PointsKeysSection({ user }: { user: SessionUser }) {
  const items = useMyPointsKeys(user.id).data?.items ?? [];
  return (
    <Reveal show={items.length > 0}>
      {items.length > 0 && (
        <PageSection
          title="三方积分密钥"
          id="me-points-keys"
          description="你填在三方积分里、发红包时用来扣积分的密钥。换或删到那个积分的页面。"
        >
          <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
            {items.map((item) => (
              <KeyRow key={item.system.id} item={item} />
            ))}
          </Panel>
        </PageSection>
      )}
    </Reveal>
  );
}
