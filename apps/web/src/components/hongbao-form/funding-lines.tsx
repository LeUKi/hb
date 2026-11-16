// 从哪发 (docs/redesign/07-pages.md 发多少): the line under the cards, one
// look for every source — where the chosen one stands, and one button on
// its right that fixes or manages it.
import type { Merchant } from "@hb/contracts";
import { KeyRound, Store, Wallet } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBalanceFunding } from "../../lib/balance";
import { useCurrentMerchant } from "../../lib/merchants";
import { useSessionUser } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { Swap } from "../ui/reveal";
import { ldc } from "./form-state";
import { MerchantDialog } from "./merchant-dialog";

export type LineTone = "ok" | "warn" | "loading";

/**
 * Grey when it can be used, amber when something is missing, turned down
 * or short, the sheen while reading. `state` names what it says: a new
 * state fades in over the old one.
 */
export function FundingLine({
  state,
  tone,
  text,
  action,
}: {
  state: string;
  tone: LineTone;
  text: string;
  action?: ReactNode;
}) {
  return (
    <Swap id={state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-sm">
        <span
          className={
            tone === "loading"
              ? "loading-sheen min-w-0 text-ink-3"
              : tone === "ok"
                ? "min-w-0 text-ink-2"
                : "min-w-0 text-warning"
          }
        >
          {text}
        </span>
        {action}
      </div>
    </Swap>
  );
}

/** A button on the line that opens a window over the form. */
export function LineButton({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="quiet"
      size="sm"
      className="shrink-0 gap-1.5"
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {icon}
      {children}
    </Button>
  );
}

/** A button on the line that leaves the form for another page. */
function LineLink({
  to,
  icon,
  children,
}: {
  to: "/merchant" | "/balance";
  icon: ReactNode;
  children: ReactNode;
}) {
  const { leaveTo } = useOmniboxController();
  return (
    <ButtonLink
      href={to}
      onGo={() => void leaveTo({ to })}
      className="shrink-0 gap-1.5"
    >
      {icon}
      {children}
    </ButtonLink>
  );
}

type MerchantState =
  | "loading"
  | "none"
  | "rejected"
  | "checking"
  | "unavailable"
  | "ok";

function merchantState(merchant: Merchant | null, loaded: boolean) {
  if (!loaded) return "loading";
  if (!merchant) return "none";
  const status = merchant.credentialVerification.status;
  return status === "rejected" ||
    status === "checking" ||
    status === "unavailable"
    ? status
    : "ok";
}

/** Only the merchant to send from: its line shows when there is work. */
export function useMerchantNeedsWork() {
  const user = useSessionUser();
  const { merchant, loaded } = useCurrentMerchant(user?.id ?? "");
  const state = merchantState(merchant, loaded);
  return state === "none" || state === "rejected" || state === "unavailable";
}

/** LDC 商户: which one pays, or what it lacks; 配置 and 换密钥 stay here. */
export function MerchantLine() {
  const user = useSessionUser();
  const { merchant, loaded } = useCurrentMerchant(user?.id ?? "");
  const [open, setOpen] = useState(false);
  const state: MerchantState = merchantState(merchant, loaded);
  const name = merchant ? `「${merchant.label}」` : "";
  const text = {
    loading: "正在读你的商户",
    none: "还没有配置 LDC 商户",
    rejected: "商户的 Client ID 或密钥没通过检查，换好才能开放",
    checking: `正在检查商户${name}的密钥`,
    unavailable: `暂时查不了商户${name}的密钥，开放时会再查`,
    ok: `从商户${name}付`,
  }[state];
  const tone: LineTone =
    state === "loading" || state === "checking"
      ? "loading"
      : state === "ok"
        ? "ok"
        : "warn";
  return (
    <>
      <FundingLine
        state={`merchant:${state}`}
        tone={tone}
        text={text}
        action={
          state === "loading" ? undefined : state === "none" ||
            state === "rejected" ? (
            <LineButton
              icon={<KeyRound aria-hidden="true" />}
              onClick={() => setOpen(true)}
            >
              {state === "none" ? "配置商户" : "换密钥"}
            </LineButton>
          ) : (
            <LineLink to="/merchant" icon={<Store aria-hidden="true" />}>
              管理
            </LineLink>
          )
        }
      />
      <MerchantDialog
        open={open}
        merchant={state === "rejected" ? merchant : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** 🐟额: 可用, none, or short of the total; 转入 is on the 🐟额 page. */
export function FishLine({ total }: { total: number | null }) {
  const user = useSessionUser();
  const funding = useBalanceFunding(user?.id ?? "");
  const data = funding.data;
  const available = Math.max(0, data?.availableMinor ?? 0);
  const state = !data
    ? funding.isError
      ? "error"
      : "loading"
    : data.available !== true
      ? "none"
      : total !== null && total > available
        ? "short"
        : "ok";
  const text = {
    loading: "正在读你的🐟额",
    error: "读不到你的🐟额，请稍后再试",
    none: "🐟额里没有可用",
    short: `可用只有 ${ldc(available)} 🐟，不够发这个红包`,
    ok: `可用 ${ldc(available)} 🐟`,
  }[state];
  return (
    <FundingLine
      state={`balance:${state}`}
      tone={state === "loading" ? "loading" : state === "ok" ? "ok" : "warn"}
      text={text}
      action={
        state === "loading" ? undefined : (
          <LineLink to="/balance" icon={<Wallet aria-hidden="true" />}>
            去🐟额
          </LineLink>
        )
      }
    />
  );
}
