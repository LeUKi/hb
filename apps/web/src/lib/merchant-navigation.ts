import { z } from "zod";

export type MerchantSearch = {
  merchantId?: string;
  dialog?: "payments" | "payment";
  taskId?: string;
};

declare module "@tanstack/react-router" {
  interface HistoryState {
    hbMerchantDialog?: {
      merchantId: string;
      base: number | null;
      listIndex: number | null;
    };
  }
}

export function merchantSearch(
  search: Record<string, unknown>,
): MerchantSearch {
  const merchantId = z.uuid().safeParse(search.merchantId);
  // An explicitly requested invalid object must not select the default merchant.
  if (!merchantId.success)
    return search.merchantId !== undefined ||
      search.dialog === "payment" ||
      search.dialog === "payments"
      ? {
          merchantId:
            typeof search.merchantId === "string" ? search.merchantId : "",
          ...(search.dialog === "payment"
            ? {
                dialog: "payment" as const,
                taskId: typeof search.taskId === "string" ? search.taskId : "",
              }
            : search.dialog === "payments"
              ? { dialog: "payments" as const }
              : {}),
        }
      : {};
  if (search.dialog === "payments")
    return { merchantId: merchantId.data, dialog: "payments" };
  if (search.dialog === "payment")
    return {
      merchantId: merchantId.data,
      dialog: "payment",
      taskId: typeof search.taskId === "string" ? search.taskId : "",
    };
  return { merchantId: merchantId.data };
}

export function isMerchantResourceId(value: unknown): value is string {
  return z.uuid().safeParse(value).success;
}

export function merchantPaymentHref(
  merchantId: string,
  taskId?: string | null,
) {
  const search = new URLSearchParams({
    merchantId,
    dialog: taskId ? "payment" : "payments",
  });
  if (taskId) search.set("taskId", taskId);
  return `/my/merchants?${search.toString()}`;
}

/** Same-merchant overlays change the view, without leaving the configuration. */
export function staysOnMerchant(
  current: { pathname: string; search: Record<string, unknown> },
  next: { pathname: string; search: Record<string, unknown> },
  merchantId: string,
) {
  return (
    current.pathname === "/my/merchants" &&
    next.pathname === current.pathname &&
    (current.search.merchantId ?? merchantId) === merchantId &&
    (next.search.merchantId ?? merchantId) === merchantId
  );
}
