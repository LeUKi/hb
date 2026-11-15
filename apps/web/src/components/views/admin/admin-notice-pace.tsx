import type { NoticePace } from "@hb/contracts";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { refused } from "../../../lib/activities";
import { useNoticePace, useSaveNoticePace } from "../../../lib/notices";
import { PageSection, Panel } from "../../page/page";
import { LeaveGuard } from "../../shell/leave-guard";
import { Button } from "../../ui/button";
import { Field, TextInput } from "../../ui/field";
import { Reveal, RevealInline } from "../../ui/reveal";

const whole = (value: string, max: number) =>
  /^\d+$/.test(value.trim()) && Number(value) <= max;

/**
 * 私信通知的间隔 (docs/notification-design.md §2.3): the 社区 drops mail
 * that comes too close together, so any two wait a little and two to one
 * person longer. Saved against the version read; in effect at once.
 */
export function NoticePaceSection() {
  const query = useNoticePace();
  const pace = query.data?.pace;
  return (
    <Reveal show={Boolean(pace)}>{pace && <PaceForm saved={pace} />}</Reveal>
  );
}

function PaceForm({ saved }: { saved: NoticePace }) {
  const save = useSaveNoticePace();
  const [draft, setDraft] = useState<{ any?: string; same?: string }>({});
  const any = draft.any ?? String(saved.anyGapSeconds);
  const same = draft.same ?? String(saved.samePersonGapSeconds);
  const ok = whole(any, 600) && whole(same, 3600);
  const changed =
    draft.any !== undefined || draft.same !== undefined
      ? !ok ||
        Number(any) !== saved.anyGapSeconds ||
        Number(same) !== saved.samePersonGapSeconds
      : false;
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const ids = { any: useId(), same: useId() };
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2400);
    return () => window.clearTimeout(timer);
  }, [done]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ok || save.isPending) return;
    setError(null);
    setDone(false);
    try {
      await save.mutateAsync({
        expectedVersion: saved.version,
        anyGapSeconds: Number(any),
        samePersonGapSeconds: Number(same),
      });
      setDraft({});
      setDone(true);
    } catch (failure) {
      setError(
        refused(failure) && failure.status === 409
          ? "设置刚被改过，已经读到最新的，你的输入还在，确认后再保存一次。"
          : refused(failure)
            ? failure.message
            : "保存结果未知：网络或服务出了问题。稍后刷新看看是否已经生效。",
      );
    }
  };

  return (
    <PageSection
      title="私信通知的间隔"
      description="社区收到挨得太近的信只会转成第一封私信，其余的会丢。发给不同的人隔得短一些，发给同一个人隔得长一些。"
    >
      <Panel>
        <LeaveGuard
          when={changed && !save.isPending}
          message="私信通知的间隔改过还没保存，离开后会丢失。"
        />
        <form className="flex flex-col gap-4 p-5" onSubmit={submit} noValidate>
          <div className="grid gap-4 @wide/window:grid-cols-2">
            <Field
              label="任意两封之间"
              htmlFor={ids.any}
              hint="默认 20 秒"
              error={whole(any, 600) ? null : "请填写 0–600 的整数"}
              live
            >
              <TextInput
                id={ids.any}
                inputMode="numeric"
                suffix="秒"
                value={any}
                invalid={!whole(any, 600)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    any: event.target.value,
                  }))
                }
              />
            </Field>
            <Field
              label="同一个人的两封之间"
              htmlFor={ids.same}
              hint="默认 20 秒"
              error={whole(same, 3600) ? null : "请填写 0–3600 的整数"}
              live
            >
              <TextInput
                id={ids.same}
                inputMode="numeric"
                suffix="秒"
                value={same}
                invalid={!whole(same, 3600)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    same: event.target.value,
                  }))
                }
              />
            </Field>
          </div>
          <Reveal show={Boolean(error)}>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          </Reveal>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={saveRef}
              type="submit"
              variant="primary"
              aria-disabled={!changed || !ok || save.isPending || undefined}
              data-disabled={!changed || !ok || undefined}
            >
              {save.isPending ? "正在保存…" : "保存设置"}
            </Button>
            <RevealInline show={changed && !save.isPending}>
              <Button
                variant="quiet"
                onClick={() => {
                  setDraft({});
                  setError(null);
                  saveRef.current?.focus();
                }}
              >
                撤销修改
              </Button>
            </RevealInline>
            <span role="status" className="text-sm text-success">
              <RevealInline show={done}>
                <span className="inline-flex items-center gap-1">
                  <Check className="size-4" aria-hidden="true" />
                  已保存，立即生效
                </span>
              </RevealInline>
            </span>
          </div>
        </form>
      </Panel>
    </PageSection>
  );
}
