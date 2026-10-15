import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Check, ChevronRight } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  auditRecords,
  type RateLimits,
  savedRateLimits,
} from "../../../fixtures/admin";
import { clockLabel } from "../../../lib/roster-time";
import { sessionAtom, submitSimAtom } from "../../../lib/store";
import { PageSection, Panel } from "../../page/page";
import { LeaveGuard } from "../../shell/leave-guard";
import { Button } from "../../ui/button";
import { Field, TextInput } from "../../ui/field";
import { AdminFrame } from "./admin-frame";

const valid = (value: string) =>
  /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 3600;

/**
 * /admin/settings 网站设置: the one thing an admin can change — how long a
 * person waits between two 口令 attempts, on the start page and on a 红包
 * page (production defaults 5 s and 2 s). Saves are checked against the
 * version read, so two admins cannot overwrite each other unseen.
 * (登录方式 / LiteAUTH is gone with 青春版.)
 */
export function AdminSettings() {
  const user = useAtomValue(sessionAtom);
  const [saved, setSaved] = useState(() => ({ ...savedRateLimits }));
  const [home, setHome] = useState(String(saved.value.home));
  const [page, setPage] = useState(String(saved.value.page));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitSim = useAtomValue(submitSimAtom);
  const failedOnce = useRef(false);
  const ids = { home: useId(), page: useId() };
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2400);
    return () => window.clearTimeout(timer);
  }, [done]);
  const next: RateLimits = { home: Number(home), page: Number(page) };
  const changed =
    next.home !== saved.value.home || next.page !== saved.value.page;
  const ok = valid(home) && valid(page);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ok || busy) return;
    setBusy(true);
    setError(null);
    window.setTimeout(() => {
      const at = Date.now();
      // Dev toolbar 提交结果: the first try fails. 版本冲突 plays another
      // admin saving first (production checks the version): the page takes
      // their version as the new baseline and keeps what was typed.
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setBusy(false);
        if (submitSim === "conflict") {
          const theirs = { home: 8, page: 3 };
          const other = { displayName: "另一位管理员", id: "admin-other" };
          auditRecords.unshift({
            id: `${at}-other`,
            at: at - 20_000,
            operator: other,
            from: saved.version,
            to: saved.version + 1,
            before: saved.value,
            after: theirs,
          });
          const latest = {
            version: saved.version + 1,
            value: theirs,
            updatedAt: at - 20_000,
            operator: other,
          };
          Object.assign(savedRateLimits, latest);
          setSaved(latest);
          setError(
            `保存失败：设置刚被另一位管理员改成第 ${latest.version} 版（起始页 ${theirs.home} 秒、红包页 ${theirs.page} 秒）。你的输入还在，确认后再保存一次。`,
          );
          return;
        }
        setError(
          submitSim === "throttled"
            ? "尝试过于频繁，请稍后重试。"
            : "保存没有完成：网络或服务出了问题，设置没有改。可以再试一次。",
        );
        return;
      }
      const operator = {
        displayName: user?.displayName ?? "管理员",
        id: savedRateLimits.operator.id,
      };
      // Every save is one 操作记录 (newest first) and the new baseline.
      auditRecords.unshift({
        id: `${at}`,
        at,
        operator,
        from: saved.version,
        to: saved.version + 1,
        before: saved.value,
        after: next,
      });
      const latest = {
        version: saved.version + 1,
        value: next,
        updatedAt: at,
        operator,
      };
      Object.assign(savedRateLimits, latest);
      setSaved(latest);
      setBusy(false);
      setDone(true);
    }, 600);
  };
  return (
    <AdminFrame description="能改的只有尝试间隔。保存后立即生效，并记进操作记录。">
      <PageSection
        title="口令尝试间隔"
        description="同一个人两次提交口令之间至少隔多久。起始页查口令和红包页领取分开计算；无需口令的红包按红包页的间隔。"
      >
        <Panel>
          <LeaveGuard
            when={changed && !busy}
            message="网站设置改过的内容还没保存，离开后会丢失。"
          />
          <form className="grid gap-4 p-5" onSubmit={submit} noValidate>
            <div className="grid gap-4 @wide/window:grid-cols-2">
              <Field
                label="起始页"
                htmlFor={ids.home}
                hint="默认 5 秒"
                error={valid(home) ? null : "请填写 1–3600 的整数"}
                live
              >
                <TextInput
                  id={ids.home}
                  inputMode="numeric"
                  suffix="秒"
                  value={home}
                  invalid={!valid(home)}
                  onChange={(event) => setHome(event.target.value)}
                />
              </Field>
              <Field
                label="红包页"
                htmlFor={ids.page}
                hint="默认 2 秒"
                error={valid(page) ? null : "请填写 1–3600 的整数"}
                live
              >
                <TextInput
                  id={ids.page}
                  inputMode="numeric"
                  suffix="秒"
                  value={page}
                  invalid={!valid(page)}
                  onChange={(event) => setPage(event.target.value)}
                />
              </Field>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={!changed || !ok || busy}
              >
                {busy ? "正在保存…" : "保存设置"}
              </Button>
              {changed && !busy && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setHome(String(saved.value.home));
                    setPage(String(saved.value.page));
                  }}
                >
                  撤销修改
                </Button>
              )}
              <span role="status" className="text-sm text-success">
                {done && (
                  <span className="inline-flex items-center gap-1">
                    <Check className="size-4" aria-hidden="true" />
                    已保存，立即生效
                  </span>
                )}
              </span>
            </div>
          </form>
        </Panel>
        <p className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-ink-3">
          第 {saved.version} 版 · {clockLabel(saved.updatedAt)} 由{" "}
          {saved.operator.displayName} 修改
          <Link
            to="/admin/audit"
            className="inline-flex items-center gap-0.5 text-ink-2 hover:text-ink"
          >
            操作记录
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Link>
        </p>
      </PageSection>
    </AdminFrame>
  );
}
