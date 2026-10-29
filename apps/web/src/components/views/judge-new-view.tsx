import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FolderCode } from "lucide-react";
import { useEffect, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { prefetchOwnJudgePage, useJudgePage } from "../../lib/judge";
import { type SessionUser, useIdentity } from "../../lib/session";
import { JudgeNameFields, JudgeWriter } from "../hongbao-form/code-step";
import type { Update } from "../hongbao-form/fields";
import {
  emptyForm,
  type FormState,
  issuesOf,
} from "../hongbao-form/form-state";
import { noVersions } from "../hongbao-form/judge-versions";
import { useJudgeDeploy } from "../hongbao-form/use-judge-deploy";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Page, PageHeader } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { LeaveGuard } from "../shell/leave-guard";
import { Button } from "../ui/button";
import { MessageView } from "./message-view";

// 写一个判定器 /judges/new (docs/judge-square-design.md §15.4, §15.5): a
// 判定器 and nothing else — no 红包 — written as on 发红包's step 2; its
// first deploy makes it, and the page becomes its 判定器页. ?from=<编号> is
// 复制一份来改 (§8): another's code, name and line, its tests one's own to
// write, its source kept.

/** The fields a mistake shows on here. */
const shownFields = new Set([
  "hb-judge-name",
  "hb-judge-description",
  "hb-code-code",
  "hb-code-tests",
]);

/** Focus on the test results once its page has them (§15.4). */
function focusResults() {
  let tries = 0;
  const step = () => {
    const results = document.getElementById("hb-code-check");
    if (results) results.focus({ preventScroll: false });
    else if (tries++ < 40) window.setTimeout(step, 50);
  };
  window.setTimeout(step, 50);
}

function NewJudge({
  user,
  seed,
}: {
  user: SessionUser;
  seed?: {
    id: string;
    name: string;
    description: string;
    code: string;
    author: string;
  };
}) {
  const navigate = useNavigate();
  const [start] = useState<FormState>(() => {
    const base = emptyForm();
    return {
      ...base,
      mode: "code",
      judge: {
        ...base.judge,
        judgeId: null,
        name: seed?.name ?? "",
        description: seed?.description ?? "",
        code: seed?.code ?? "",
        tests: "",
        versions: noVersions(),
      },
    };
  });
  const [form, setForm] = useState(start);
  const update: Update = (change) => setForm(change);
  const [said, setSaid] = useState("");
  const deploy = useJudgeDeploy({
    form,
    userId: user.id,
    update,
    say: setSaid,
    basedOn: seed?.id,
  });
  const issues = issuesOf(form);
  const errorOf = (field: string) =>
    shownFields.has(field)
      ? issues.find((issue) => issue.field === field)?.message
      : undefined;
  // Its first deploy made it: on to its page, the results there — read
  // whole first, so it opens at once rather than in steps.
  const queryClient = useQueryClient();
  const made = form.judge.judgeId;
  const madeN = form.judge.versions.versions.at(-1)?.n ?? 1;
  useEffect(() => {
    if (!made) return;
    let gone = false;
    void prefetchOwnJudgePage(queryClient, user.id, made, madeN).then(
      async () => {
        if (gone) return;
        await navigate({
          to: "/judges/$judgeId",
          params: { judgeId: made },
          replace: true,
        });
        focusResults();
      },
    );
    return () => {
      gone = true;
    };
  }, [made, madeN, navigate, queryClient, user.id]);
  const changed =
    !made &&
    (form.judge.code !== start.judge.code ||
      form.judge.tests !== start.judge.tests ||
      form.judge.name !== start.judge.name ||
      form.judge.description !== start.judge.description);
  return (
    <Page>
      <PageHeader eyebrow="判定器广场" title="写一个判定器" />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid gap-2">
          <JudgeNameFields
            form={form}
            update={update}
            errorOf={errorOf}
            locked={false}
          />
          {seed && (
            <p className="text-sm text-ink-2">
              基于 @{seed.author} 的判定器，署名会一直留着。
            </p>
          )}
        </div>
        <JudgeWriter
          form={form}
          update={update}
          errorOf={errorOf}
          locked={false}
          frozen={false}
          judge={deploy}
          gated={false}
          testsNote={seed ? "别人的测试不公开，要自己写。" : undefined}
        />
        <p role="status" className="sr-only">
          {said}
        </p>
      </div>
      <LeaveGuard when={changed} message="改过的内容还没保存，离开后会丢失。" />
    </Page>
  );
}

/** 复制一份来改: its source as the 广场 shows it, then the page. */
function CopyOf({ user, from }: { user: SessionUser; from: string }) {
  const query = useJudgePage(user.id, from);
  const source = query.data;
  const error = query.error;
  if (
    (error instanceof ActivityRequestError && error.status === 404) ||
    (source && !source.version?.code)
  )
    return (
      <MessageView
        title="未找到判定器"
        text="判定器不存在，或者不在判定器广场里。"
      />
    );
  return (
    <PageLoad load={queryLoad(query)}>
      {source?.version?.code && (
        <NewJudge
          user={user}
          seed={{
            id: source.id,
            name: source.name,
            description: source.description,
            code: source.version.code,
            author: source.author.username,
          }}
        />
      )}
    </PageLoad>
  );
}

export function JudgeNewView() {
  const { user } = useIdentity();
  const { openAccount } = useOmniboxController();
  const asked = useSearch({
    strict: false,
    select: (search) => (search as { from?: string }).from,
  });
  const [from] = useState(asked);
  if (!user)
    return (
      <MessageView
        icon={FolderCode}
        title="写一个判定器"
        text="登录后可以使用。"
        action={
          <Button variant="primary" onClick={openAccount}>
            登录
          </Button>
        }
      />
    );
  return from ? <CopyOf user={user} from={from} /> : <NewJudge user={user} />;
}
