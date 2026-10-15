import type { ManagedActivity, Merchant } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ActivityRequestError, activityKeys, readResponse } from "./activities";
import { type SessionResponse, sessionIdentity, sessionQueryKey } from "./auth";

export type OpeningPhase = "idle" | "checking" | "opening";

function waitForCheck(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("操作已取消", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 2_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A click may continue opening only while this account and page are still active. */
export function useActivityOpening(userId: string, csrfToken: string) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<OpeningPhase>("idle");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function open(activity: ManagedActivity) {
    if (controller.current) throw new Error("红包正在开放，请稍候。");
    const operation = new AbortController();
    controller.current = operation;
    const { signal } = operation;
    const initialUser =
      queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user;
    const initialIdentity = sessionIdentity(initialUser ?? null);
    const sessionMatches = () =>
      queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user?.id ===
        userId &&
      sessionIdentity(
        queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user ??
          null,
      ) === initialIdentity;
    function assertActive() {
      if (signal.aborted || !sessionMatches()) {
        operation.abort();
        throw new DOMException("操作已取消", "AbortError");
      }
    }
    const options = {
      headers: { "X-CSRF-Token": csrfToken },
      init: { signal, cache: "no-store" as const },
    };
    const merchantId =
      activity.config.rewardType === "ldc" && activity.paymentMode === "real"
        ? activity.config.merchantId
        : null;
    const readMerchant = async () => {
      if (!merchantId) return null;
      assertActive();
      const result = await readResponse<{ merchant: Merchant }>(
        await api.api.me.merchants[":id"].$get(
          { param: { id: merchantId } },
          options,
        ),
      );
      assertActive();
      return result.merchant;
    };
    const readActivity = async () => {
      assertActive();
      const result = await readResponse<{ activity: ManagedActivity }>(
        await api.api.me.activities[":id"].$get(
          { param: { id: activity.id } },
          options,
        ),
      );
      assertActive();
      const current = result.activity;
      if (
        current.config.rewardType !== activity.config.rewardType ||
        (current.config.rewardType === "ldc" &&
          activity.config.rewardType === "ldc" &&
          current.config.merchantId !== activity.config.merchantId)
      )
        throw new Error("红包已修改，请检查配置后重新开放。");
      if (current.openedAt) {
        if (current.version !== activity.version + 1)
          throw new Error("红包已修改，请检查配置后重新开放。");
        return current;
      }
      if (current.version !== activity.version)
        throw new Error("红包已修改，请检查配置后重新开放。");
      return current;
    };
    async function remember(opened: ManagedActivity) {
      assertActive();
      queryClient.setQueryData(activityKeys.detail(userId, activity.id), {
        activity: opened,
      });
      await queryClient.invalidateQueries({
        queryKey: activityKeys.mine(userId),
      });
      assertActive();
      await queryClient.invalidateQueries({
        queryKey: ["activity-public", activity.id],
      });
      return opened;
    }
    try {
      assertActive();
      setPhase("opening");
      const merchant = await readMerchant();
      const credentialVersion = merchant?.credentialVersion;
      const deadline = Date.now() + 60_000;
      while (true) {
        assertActive();
        try {
          setPhase("opening");
          const result = await readResponse<{ activity: ManagedActivity }>(
            await api.api.me.activities[":id"].open.$post(
              {
                param: { id: activity.id },
                json: {
                  version: activity.version,
                  ...(merchantId && credentialVersion !== undefined
                    ? { merchantId, credentialVersion }
                    : {}),
                },
              },
              options,
            ),
          );
          return await remember(result.activity);
        } catch (error) {
          assertActive();
          if (
            !(error instanceof ActivityRequestError) ||
            error.code !== "MERCHANT_CREDENTIALS_CHECKING"
          ) {
            if (
              !(error instanceof ActivityRequestError) ||
              error.status >= 500
            ) {
              const current = await readActivity();
              if (current.openedAt) return await remember(current);
            }
            throw error;
          }
          setPhase("checking");
        }
        while (true) {
          if (Date.now() >= deadline)
            throw new Error("凭证检查仍未完成。草稿已保存，可以稍后继续开放。");
          await waitForCheck(signal);
          assertActive();
          const current = await readActivity();
          if (current.openedAt) return await remember(current);
          const checked = await readMerchant();
          if (checked?.credentialVersion !== credentialVersion)
            throw new Error("商户凭证已更新，请检查商户配置后重新开放。");
          if (checked?.credentialVerification.status === "checking") continue;
          if (checked?.credentialVerification.status !== "passed")
            throw new Error(
              checked?.credentialVerification.status === "rejected"
                ? "商户认证未通过，请更新凭证后再开放。"
                : "暂时无法验证商户凭证。草稿已保存，请稍后重试。",
            );
          break;
        }
      }
    } catch (error) {
      if (
        sessionMatches() &&
        error instanceof ActivityRequestError &&
        error.status === 401
      )
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
      throw error;
    } finally {
      if (controller.current === operation) {
        controller.current = null;
        setPhase("idle");
      }
    }
  }
  return { open, phase, isPending: phase !== "idle" };
}
