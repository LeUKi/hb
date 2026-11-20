import {
  JUDGE_NOTICE_MAX,
  type JudgeNotice,
  judgeNoticeSchema,
  type MyJudgeDetail,
} from "@hb/contracts";
import { Megaphone } from "lucide-react";
import { useEffect, useState } from "react";
import { refused } from "../../lib/activities";
import { useSetJudgeNotice } from "../../lib/judge";
import { counter } from "../hongbao-form/fields";
import { Callout, Panel } from "../page/page";
import { Button } from "../ui/button";
import { Field, Switch, TextArea } from "../ui/field";
import { Reveal } from "../ui/reveal";

// 过时 and 公告 (docs/judge-square-design.md §20): a 判定器's author tells
// those who send 红包 with it, on the platform, without deploying.

/** "11月20日", as a 公告's time is said. */
export function noticeDate(at: string) {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * What its author said, for whoever is about to use it, or did; `whose`
 * names them where the page is not the 判定器's own (a 红包 run on it).
 */
export function noticeWords({
  outdated,
  notice,
  whose = "作者",
}: {
  outdated?: boolean;
  notice?: JudgeNotice | null;
  whose?: string;
}) {
  if (!outdated && !notice) return null;
  return {
    title: notice
      ? `${whose === "作者" ? "作者公告" : `${whose}的公告`} · ${noticeDate(notice.at)}`
      : `${whose}已把它标为过时`,
    lines: [
      notice?.text ?? "作者不再维护它，用之前留意风险。",
      ...(notice && outdated ? [`${whose}已把它标为过时。`] : []),
    ],
  };
}

/** Under a 判定器's title, and on its sender's own 红包 page. */
export function JudgeNoticeCallout({
  outdated,
  notice,
  whose,
}: {
  outdated?: boolean;
  notice?: JudgeNotice | null;
  /** "判定器作者", where the page is not the 判定器's own. */
  whose?: string;
}) {
  const words = noticeWords({ outdated, notice, whose });
  if (!words) return null;
  return (
    <Callout icon={Megaphone} title={words.title}>
      {words.lines.map((line) => (
        <span key={line} className="block whitespace-pre-wrap">
          {line}
        </span>
      ))}
    </Callout>
  );
}

/** Its author's: the 公告, saved by hand, and 标为过时, at once. */
export function NoticeSettings({
  judge,
  userId,
  onChanged,
}: {
  judge: MyJudgeDetail;
  userId: string;
  onChanged: (changed: boolean) => void;
}) {
  const saved = judge.notice?.text ?? "";
  const [text, setText] = useState(saved);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = useSetJudgeNotice(userId, judge.id);
  const read = judgeNoticeSchema.shape.notice.safeParse(text);
  const tooLong = read.success ? undefined : read.error.issues[0]?.message;
  const changed = text.trim() !== saved;
  useEffect(() => onChanged(changed), [changed, onChanged]);
  const failed = (failure: unknown) =>
    refused(failure)
      ? failure.message
      : "保存没有完成：网络或服务出了问题。可以再试一次。";
  const save = () => {
    if (write.isPending || !changed || !read.success) return;
    setError(null);
    write.mutate(
      { notice: read.data, outdated: judge.outdated },
      {
        onSuccess: (next) => {
          setText(next.notice?.text ?? "");
          setDone(true);
        },
        onError: (failure) => setError(failed(failure)),
      },
    );
  };
  // Turned at once; back if the save fails.
  const outdated =
    write.isPending && write.variables
      ? write.variables.outdated
      : judge.outdated;
  return (
    <Panel className="grid gap-4 p-4">
      {/* The section's heading names it: one title (07 §1). */}
      <Field
        label="公告"
        labelHidden
        htmlFor="judge-notice"
        error={tooLong}
        hint="写给用它发红包的人，比如服务器什么时候维护、哪一版有什么问题。改了马上生效，不用重新部署。"
        aside={counter(text, JUDGE_NOTICE_MAX)}
      >
        <TextArea
          id="judge-notice"
          rows={3}
          value={text}
          invalid={Boolean(tooLong)}
          onChange={(event) => {
            setText(event.target.value);
            setDone(false);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="sm"
          aria-disabled={write.isPending || !changed || undefined}
          onClick={save}
        >
          {write.isPending && changed ? "正在保存…" : "保存"}
        </Button>
        <p role="status" className="text-sm text-success">
          {done && !changed ? (saved ? "已保存" : "已去掉公告") : ""}
        </p>
      </div>
      <div className="border-line border-t pt-4">
        <Switch
          checked={outdated}
          label="标为过时"
          description="告诉想用它的人，你不再维护它。已经开放的红包照常运行。"
          onChange={(on) => {
            if (write.isPending) return;
            setError(null);
            write.mutate(
              { notice: saved, outdated: on },
              { onError: (failure) => setError(failed(failure)) },
            );
          }}
        />
      </div>
      <Reveal show={Boolean(error)}>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </Reveal>
    </Panel>
  );
}
