import type { JudgePage } from "@hb/contracts";
import { useState } from "react";
import { fixedAddresses } from "../../../../../kit/runtime/network.mjs";
import { refused } from "../../lib/activities";
import { fetchJudgePage } from "../../lib/judge";
import { addressLabel } from "../judges/judge-bits";
import { noticeWords } from "../judges/judge-notice";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { type FormState, withJudgeDefaults } from "./form-state";
import { noVersions } from "./judge-versions";
import { paramsFor } from "./params-fields";

// Another's 判定器 for a draft (docs/judge-square-design.md §7, §15.3,
// §15.4): the version others use, read from its page, put in as the
// form's — no deploy — after 这个判定器会联网 is answered when it goes
// online to addresses not confirmed yet: those written in its code, not an
// 地址参数, which its sender fills in (docs/judge-address-design.md §4).

/** The same addresses, whatever their order. */
const sameAddresses = (left: string[], right: string[] | null) =>
  right !== null &&
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export type BorrowOutcome =
  | { picked: JudgePage }
  /** One's own after all: the caller picks it as its own. */
  | { own: JudgePage }
  | { cancelled: true }
  | { failed: true };

export function useBorrowJudge() {
  const [asking, setAsking] = useState<{
    page: JudgePage;
    network: string[];
    /** Its 地址参数 it also asks, by name. */
    filled: string[];
    answer: (go: boolean) => void;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = (go: boolean) => {
    asking?.answer(go);
    setAsking(null);
  };

  /**
   * Its page read; 联网 asked about unless `acked` has its addresses; then
   * the form changed by `commit` (the form's own update, or the start of a
   * new one).
   */
  const pick = async (
    judgeId: string,
    {
      acked,
      commit,
    }: {
      acked: string[] | null;
      commit: (change: (form: FormState) => FormState) => void;
    },
  ): Promise<BorrowOutcome> => {
    setBusy(true);
    setError(null);
    try {
      const page = await fetchJudgePage(judgeId);
      if (page.own) return { own: page };
      // 在更新 (judge-square §17): none picks it anew meanwhile.
      if (page.updating !== undefined) {
        setError("作者在更新这个判定器，新版本发过红包后才能用。");
        return { failed: true };
      }
      const version = page.version;
      const code = version?.code;
      if (!version || !code) {
        setError("这个判定器现在没有能用的版本。");
        return { failed: true };
      }
      const network = version.network;
      const fixed = network ? fixedAddresses(network) : null;
      const online =
        fixed !== null && fixed.length > 0 && !sameAddresses(fixed, acked);
      // 过时 and 公告 (judge-square §20): its author's words, every pick.
      if (online || page.outdated || page.notice) {
        const params = version.declarations?.params ?? [];
        const filled = (network ?? []).flatMap((entry) =>
          typeof entry !== "string" && "param" in entry
            ? [addressLabel(params, entry.param)]
            : [],
        );
        const go = await new Promise<boolean>((resolve) =>
          setAsking({
            page,
            network: online && fixed ? fixed : [],
            filled,
            answer: resolve,
          }),
        );
        if (!go) return { cancelled: true };
      }
      commit((current) =>
        withJudgeDefaults(
          {
            ...current,
            judge: {
              ...current.judge,
              judgeId: page.id,
              name: page.name,
              description: page.description,
              code,
              tests: "",
              versions: noVersions(),
              params: paramsFor(
                version.declarations?.params ?? [],
                current.judge.params,
              ),
              borrowed: {
                n: version.n,
                source: {
                  author: page.author,
                  featured: page.featured,
                  bySiteOwner: page.bySiteOwner,
                  basedOn: page.basedOn?.username ?? null,
                  listed: page.listed,
                  takenDown: false,
                  newer: null,
                },
                declarations: version.declarations,
                network,
                networkAck: fixed && fixed.length > 0 ? fixed : null,
              },
            },
          },
          version.declarations?.hongbao,
        ),
      );
      return { picked: page };
    } catch (failure) {
      setError(
        refused(failure)
          ? failure.message
          : "没有取到这个判定器：网络或服务出了问题。可以再试一次。",
      );
      return { failed: true };
    } finally {
      setBusy(false);
    }
  };

  const notice = asking
    ? noticeWords({
        outdated: asking.page.outdated,
        notice: asking.page.notice,
      })
    : null;
  const online = (asking?.network.length ?? 0) > 0;
  const sendsTo = asking
    ? `它会把领的人提交的内容发到 ${asking.network.join("、")}。那不是本站，也不是你的服务器。${asking.filled.length ? `也会发到你自己填的${asking.filled.join("、")}。` : ""}`
    : "";
  const risk = asking && (
    <>
      <p>
        判定结果由对方的服务器决定，对方随时能改，可能让奖池被领走，或者谁都领不到。
      </p>
      <p>只在你信任 @{asking.page.author.username} 时使用。</p>
    </>
  );
  const dialog = (
    <ConfirmDialog
      open={asking !== null}
      onClose={() => answer(false)}
      title={
        asking?.page.outdated
          ? "作者把这个判定器标为过时"
          : notice
            ? "作者的公告"
            : "这个判定器会联网"
      }
      // 过时 and 公告 first (judge-square §20); 联网 after, as it was.
      text={
        notice ? (
          <span className="whitespace-pre-wrap">{notice.lines[0]}</span>
        ) : (
          sendsTo
        )
      }
      actions={
        <>
          <Button onClick={() => answer(false)}>返回</Button>
          <Button variant="primary" onClick={() => answer(true)}>
            我知道，继续用
          </Button>
        </>
      }
    >
      {(!notice || online) && (
        <div className="grid gap-1 text-sm text-ink-2">
          {notice && (
            <>
              <p className="font-medium text-ink">这个判定器还会联网</p>
              <p>{sendsTo}</p>
            </>
          )}
          {risk}
        </div>
      )}
    </ConfirmDialog>
  );

  return { pick, busy, error, setError, dialog };
}
