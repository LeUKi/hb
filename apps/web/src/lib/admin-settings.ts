import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
  savedMessage,
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
  savedMessage: string;
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
  const [message, setMessage] = useState<string | null>(null);
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

  function accept(result: R, feedback: string) {
    if (!current() || controller.current.signal.aborted) return;
    queryClient.setQueryData(queryKey, result);
    setBaseline(result);
    setDraft(null);
    setPending(null);
    applied?.(result);
    setMessage(feedback);
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
        accept(result, "已核对，配置已生效。");
      } else if (result.config.version === input.expectedVersion) {
        setPending({ input, retryReady: true });
        setMessage("已核对，未发现本次保存。可以重试原提交。");
      } else {
        setPending(null);
        setMessage("网站设置已发生变化，请刷新后再试。当前输入已保留。");
      }
    } catch (error) {
      if (!denied(error)) {
        setPending({ input, retryReady: false });
        setMessage("保存结果尚未确认，核对失败，请重试核对。当前输入已保留。");
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
      setMessage(validationError);
      return;
    }
    const input = pending?.input ?? {
      ...values,
      expectedVersion: baseline.config.version,
    };
    setBusy(true);
    setMessage(null);
    try {
      await queryClient.cancelQueries({ queryKey });
      if (!current()) return;
      accept(await write(input, controller.current.signal), savedMessage);
    } catch (error) {
      if (denied(error)) return;
      if (error instanceof ActivityRequestError && error.status < 500) {
        setPending(null);
        setMessage(
          error.status === 409
            ? "网站设置已发生变化，请刷新后再试。当前输入已保留。"
            : `${error.message} 当前输入已保留。`,
        );
      } else {
        setPending({ input, retryReady: false });
        setMessage("保存结果尚未确认，正在核对。当前输入已保留。");
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
      accept(await read(controller.current.signal), "配置已刷新。");
    } catch (error) {
      if (!denied(error)) setMessage("刷新失败，请重试。");
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
    message,
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
