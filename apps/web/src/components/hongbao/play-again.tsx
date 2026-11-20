import { useNavigate } from "@tanstack/react-router";
import {
  Braces,
  CopyPlus,
  FolderCode,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useEmbedded } from "../../lib/embedded";
import type { HongbaoActivity, PublicView } from "../../lib/hongbao";
import { useMyJudgments } from "../../lib/judge";
import { useIdentity } from "../../lib/session";
import type { NewSearch } from "../../router";
import { modeLabels } from "../hongbao-form/form-state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { radius, Squircle } from "../ui/squircle";
import { UseJudgeButton, useJudgeUsable } from "./code-section";

/**
 * 接着玩 (docs/play-again-design.md, user 2026-11-20): at the foot of a 红包
 * one has taken part in (or tried its code), or one that is over, a way to
 * send one like it, the 判定器广场 and the 红包广场 — a line each, its button
 * as wide as its words, never a banner or a list of other 红包 (they would
 * take the page from this one). Its sender sees 再发一个同样的 instead.
 * Not in the 社区小程序.
 */
export function PlayAgain({
  activity,
  view,
  tookPart,
  author,
}: {
  activity: HongbaoActivity;
  view: PublicView;
  /** Claimed or signed up (the cover is pinned). */
  tookPart: boolean;
  author: boolean;
}) {
  const embedded = useEmbedded();
  const { user } = useIdentity();
  const code = activity.participation === "code";
  // Tried its code without a share: taken part as well.
  const judgments = useMyJudgments(code && user ? user.id : "", activity.id);
  const judged = (judgments.data?.pages[0]?.total ?? 0) > 0;
  if (embedded || activity.draft) return null;
  if (!author && !tookPart && !judged && !view.ended) return null;
  return (
    <section className="grid gap-2" data-hb-part="play-again">
      <div className="flex min-h-9 items-center">
        <h2 className="text-sm font-medium text-ink-3">
          {author ? "再发一个" : "接着玩"}
        </h2>
      </div>
      <ul className="grid gap-1.5">
        {author ? (
          <AuthorLine activity={activity} />
        ) : code ? (
          <>
            <CodeLines activity={activity} />
            <HongbaoSquareLine />
          </>
        ) : (
          <>
            <SameLine activity={activity} />
            <SquareLine />
            <HongbaoSquareLine />
          </>
        )}
      </ul>
    </section>
  );
}

/** One line: what it does, a word under it, its button at the end. */
function Line({
  icon: Icon,
  iconClass,
  title,
  note,
  action,
  part,
}: {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  note: string;
  action: ReactNode;
  part: string;
}) {
  return (
    <li data-hb-line={part}>
      <Squircle radius={radius.row}>
        <div className="flex items-center gap-3 bg-fill px-3.5 py-3">
          <Icon
            className={cn("size-[18px] shrink-0", iconClass)}
            aria-hidden="true"
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-base font-medium text-ink">{title}</p>
            <p className="text-xs text-ink-3">{note}</p>
          </div>
          <div className="shrink-0">{action}</div>
        </div>
      </Squircle>
    </li>
  );
}

/** To /new, set up as asked; a guest signs in first. */
function NewButton({
  search,
  label,
}: {
  search: Pick<NewSearch, "mode" | "participation" | "from">;
  label: string;
}) {
  const { user } = useIdentity();
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const query = new URLSearchParams(
    Object.entries(search).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return user ? (
    <ButtonLink
      variant="secondary"
      href={`/new?${query}`}
      onGo={() => void navigate({ to: "/new", search })}
    >
      {label}
    </ButtonLink>
  ) : (
    <Button variant="secondary" size="sm" onClick={openAccount}>
      {label}
    </Button>
  );
}

/** 用同样的玩法发一个红包 with its 判定器, or the 广场 when others can't. */
function CodeLines({ activity }: { activity: HongbaoActivity }) {
  const judge = activity.judge?.judge;
  const usable = useJudgeUsable(judge);
  const asks =
    (activity.judge?.params?.length ?? 0) > 0 ||
    (activity.judge?.sealedParams?.count ?? 0) > 0;
  return judge && usable ? (
    <Line
      part="same-judge"
      icon={Braces}
      iconClass="text-gold-mark"
      title="用同样的玩法发一个红包"
      note={
        asks
          ? "填几个参数就能发，不用写代码"
          : "不用写代码，填好金额和份数就能发"
      }
      action={<UseJudgeButton judgeId={judge.id} />}
    />
  ) : (
    <SquareLine />
  );
}

/** 也发一个: its 玩法 and 怎么领 chosen, nothing else. */
function SameLine({ activity }: { activity: HongbaoActivity }) {
  const mode = activity.mode;
  if (mode === "code") return null;
  const participation =
    activity.participation === "direct" ? "direct" : "password";
  return (
    <Line
      part="same-mode"
      icon={HongbaoIcon}
      iconClass="text-envelope"
      title="也发一个同样玩法的红包"
      note={`${participation === "password" ? "口令" : "无需口令"} · ${modeLabels[mode]}`}
      action={<NewButton search={{ mode, participation }} label="发红包" />}
    />
  );
}

/** 判定器广场: a game for one who doesn't write code. */
function SquareLine() {
  const navigate = useNavigate();
  return (
    <Line
      part="judge-square"
      icon={FolderCode}
      iconClass="text-gold-mark"
      title="想发个小游戏红包？"
      note="判定器广场里挑一个，填几个参数就能发"
      action={
        <ButtonLink
          variant="secondary"
          href="/judges"
          onGo={() => void navigate({ to: "/judges" })}
        >
          判定器广场
        </ButtonLink>
      }
    />
  );
}

/**
 * 红包广场: more to take part in, as a way there — not a list of them
 * (user 2026-11-20: it would take the page from this one, and cost reads).
 */
function HongbaoSquareLine() {
  const navigate = useNavigate();
  return (
    <Line
      part="square"
      icon={LayoutGrid}
      iconClass="text-envelope"
      title="还想再领几个红包？"
      note="红包广场里有大家正在发的红包"
      action={
        <ButtonLink
          variant="secondary"
          href="/square"
          onGo={() => void navigate({ to: "/square" })}
        >
          红包广场
        </ButtonLink>
      }
    />
  );
}

/** 再发一个同样的 (§2.2): this one, filled in again. */
function AuthorLine({ activity }: { activity: HongbaoActivity }) {
  const note =
    activity.participation === "code"
      ? "判定器和公开的参数照旧，结束后公开的参数要重新填"
      : activity.participation === "password"
        ? "照这个红包填好，口令要重新写"
        : "照这个红包填好，改改就能发";
  return (
    <Line
      part="copy"
      icon={CopyPlus}
      iconClass="text-ink-2"
      title="再发一个同样的"
      note={note}
      action={<NewButton search={{ from: activity.id }} label="再发一个" />}
    />
  );
}
