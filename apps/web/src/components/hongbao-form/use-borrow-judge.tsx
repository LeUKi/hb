import type { JudgePage } from "@hb/contracts";
import { useState } from "react";
import { refused } from "../../lib/activities";
import { fetchJudgePage } from "../../lib/judge";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { type FormState, withJudgeDefaults } from "./form-state";
import { noVersions } from "./judge-versions";
import { paramsFor } from "./params-fields";

// Another's 判定器 for a draft (docs/judge-square-design.md §7, §15.3,
// §15.4): the version others use, read from its page, put in as the
// form's — no deploy — after 这个判定器会联网 is answered when it goes
// online to addresses not confirmed yet.

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
      const version = page.version;
      const code = version?.code;
      if (!version || !code) throw new Error("no version to use");
      const network = version.network;
      if (network && !sameAddresses(network, acked)) {
        const go = await new Promise<boolean>((resolve) =>
          setAsking({ page, network, answer: resolve }),
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
                networkAck: network,
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

  const dialog = (
    <ConfirmDialog
      open={asking !== null}
      onClose={() => answer(false)}
      title="这个判定器会联网"
      text={`它会把领的人提交的内容发到 ${asking?.network.join("、") ?? ""}。那不是本站，也不是你的服务器。`}
      actions={
        <>
          <Button onClick={() => answer(false)}>返回</Button>
          <Button variant="primary" onClick={() => answer(true)}>
            我知道，继续用
          </Button>
        </>
      }
    >
      <div className="grid gap-1 text-sm text-ink-2">
        <p>
          判定结果由对方的服务器决定，对方随时能改，可能让奖池被领走，或者谁都领不到。
        </p>
        <p>只在你信任 @{asking?.page.author.username} 时使用。</p>
      </div>
    </ConfirmDialog>
  );

  return { pick, busy, error, setError, dialog };
}
