import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useActionFeedback } from "../components/ui/action-feedback";
import { ActivityRequestError } from "./activities";
import {
  adminKey,
  clearAdminPrivateOnAccessDenied,
  useCurrentAdmin,
} from "./admin";

type VersionedConfig = {
  version: number;
  updatedAt: number;
  updatedByUserId: string | null;
};
type Submission<V> = { expectedVersion: number } & V;

/** Keep the editable baseline separate from background observations. */
export function useAdminSettings<V, R extends { config: VersionedConfig }>({
  identity,
  module,
  read,
  write,
  valuesOf,
  equal,
  validate,
  applied,
  onUnsavedChange,
}: {
  identity: string;
  module: string;
  read: (signal: AbortSignal) => Promise<R>;
  write: (input: Submission<V>, signal: AbortSignal) => Promise<R>;
  valuesOf: (response: R) => V;
  equal: (left: V, right: V) => boolean;
  validate: (values: V) => string | null;
  applied?: (response: R) => void;
  onUnsavedChange: (protectedInput: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const current = useCurrentAdmin(identity);
  const queryKey = adminKey(identity, module);
  const [baseline, setBaseline] = useState<R | null>(null);
  const [draft, setDraft] = useState<V | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    input: Submission<V>;
    retryReady: boolean;
  } | null>(null);
  const submitFeedback = useActionFeedback(`${identity}:${module}:submit`);
  const refreshFeedback = useActionFeedback(`${identity}:${module}:refresh`);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await read(signal);
      if (signal.aborted || !current())
        throw new DOMException("身份已变化", "AbortError");
      return result;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!baseline && query.data) setBaseline(query.data);
  }, [baseline, query.data]);
  // Mutation requests also stop on unmount/account changes, not just GETs.
  const controller = useRef(new AbortController());
  useEffect(() => {
    const mountedController = new AbortController();
    controller.current = mountedController;
    return () => mountedController.abort();
  }, []);
  const values = draft ?? (baseline ? valuesOf(baseline) : null);
  const dirty = Boolean(draft && baseline && !equal(draft, valuesOf(baseline)));
  const protectedInput = dirty || Boolean(pending) || busy;
  useEffect(() => {
    onUnsavedChange(protectedInput);
    return () => onUnsavedChange(false);
  }, [onUnsavedChange, protectedInput]);

  function accept(result: R, action: "submit" | "refresh") {
    if (!current() || controller.current.signal.aborted) return;
    queryClient.setQueryData(queryKey, result);
    setBaseline(result);
    setDraft(null);
    setPending(null);
    applied?.(result);
    if (action === "refresh") refreshFeedback.show("已刷新");
    else submitFeedback.show("已保存");
  }

  function denied(error: unknown) {
    if (!current() || controller.current.signal.aborted) return true;
    return clearAdminPrivateOnAccessDenied(queryClient, error);
  }

  async function reconcile(input: Submission<V>) {
    try {
      const result = await read(controller.current.signal);
      if (!current() || controller.current.signal.aborted) return;
      queryClient.setQueryData(queryKey, result);
      if (
        result.config.version > input.expectedVersion &&
        equal(valuesOf(result), input)
      ) {
        accept(result, "submit");
        submitFeedback.show("已核对", "配置已生效。");
      } else if (result.config.version === input.expectedVersion) {
        setPending({ input, retryReady: true });
        submitFeedback.show(
          "需重试",
          "已核对，未发现本次保存。可以重试原提交。",
        );
      } else {
        setPending(null);
        submitFeedback.show(
          "已变化",
          "网站设置已发生变化，请刷新后再试。当前输入已保留。",
        );
      }
    } catch (error) {
      if (!denied(error)) {
        setPending({ input, retryReady: false });
        submitFeedback.show(
          "核对失败",
          "保存结果尚未确认，核对失败，请重试核对。当前输入已保留。",
        );
      }
    }
  }

  async function submit() {
    if (busy || !current() || !baseline || !values) return;
    if (pending && !pending.retryReady) {
      setBusy(true);
      await reconcile(pending.input);
      setBusy(false);
      return;
    }
    const validationError = validate(values);
    if (validationError) {
      submitFeedback.show("校验失败", validationError);
      return;
    }
    const input = pending?.input ?? {
      ...values,
      expectedVersion: baseline.config.version,
    };
    setBusy(true);
    submitFeedback.clear();
    try {
      await queryClient.cancelQueries({ queryKey });
      if (!current()) return;
      await write(input, controller.current.signal).then((result) =>
        accept(result, "submit"),
      );
    } catch (error) {
      if (denied(error)) return;
      if (error instanceof ActivityRequestError && error.status < 500) {
        setPending(null);
        submitFeedback.show(
          error.status === 409 ? "已变化" : "保存失败",
          error.status === 409
            ? "网站设置已发生变化，请刷新后再试。当前输入已保留。"
            : `${error.message} 当前输入已保留。`,
        );
      } else {
        setPending({ input, retryReady: false });
        submitFeedback.show(
          "核对中",
          "保存结果尚未确认，正在核对。当前输入已保留。",
        );
        await reconcile(input);
      }
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (busy || pending || !current()) return;
    if (dirty && !window.confirm("刷新会放弃未保存的修改，是否继续？")) return;
    setBusy(true);
    try {
      await queryClient.cancelQueries({ queryKey });
      await read(controller.current.signal).then((result) =>
        accept(result, "refresh"),
      );
    } catch (error) {
      if (!denied(error))
        refreshFeedback.show("刷新失败", "刷新失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return {
    query,
    config: baseline?.config,
    values,
    setDraft,
    dirty,
    busy,
    locked: busy || Boolean(pending),
    submitFeedback: submitFeedback.feedback,
    refreshFeedback: refreshFeedback.feedback,
    submit,
    refresh,
    submitLabel: busy
      ? "处理中…"
      : pending
        ? pending.retryReady
          ? "重试原提交"
          : "核对保存结果"
        : "保存配置",
    canSubmit: !busy && (dirty || Boolean(pending)),
  };
}
