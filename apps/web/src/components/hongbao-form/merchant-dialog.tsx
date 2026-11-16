// 从哪发 · LDC 商户 (docs/redesign/07-pages.md 发多少): 配置商户 and 换商户
// 密钥 in a window stacked on the 发红包 form, so what was typed stays.
import type { Merchant, MerchantChangePreview } from "@hb/contracts";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  MerchantChangeConfirmationError,
  useMerchantWrites,
} from "../../lib/merchants";
import { useIdentity } from "../../lib/session";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Field, TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import {
  ChangeDialog,
  clientIdError,
  saveError,
} from "../views/merchant-change";
import { MerchantGuide } from "../views/merchant-guide";

/**
 * No merchant: 名称, Client ID and 密钥, as /merchant's first form. One
 * whose 密钥 was turned down (`merchant`): its Client ID and a new 密钥;
 * with 红包 or payments still on it, the impact is asked first, as on
 * /merchant. Saved, it closes: the line under the cards says the rest.
 */
export function MerchantDialog({
  open,
  merchant,
  onClose,
}: {
  open: boolean;
  merchant: Merchant | null;
  onClose: () => void;
}) {
  const { user, csrfToken } = useIdentity();
  const titleId = useId();
  const ids = { label: useId(), client: useId(), secret: useId() };
  const writes = useMerchantWrites(
    user?.id ?? "",
    csrfToken ?? "",
    merchant?.id,
  );
  const [label, setLabel] = useState("默认商户");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MerchantChangePreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Each opening starts from what is saved.
  useEffect(() => {
    if (!open) return;
    setLabel("默认商户");
    setClientId(merchant?.clientId ?? "");
    setSecret("");
    setError(null);
    setPreview(null);
    setNote(null);
  }, [open, merchant?.clientId]);

  const busy =
    writes.create.isPending ||
    writes.update.isPending ||
    writes.changeImpact.isPending;
  const idError = clientIdError(clientId);
  const valid =
    (merchant || label.trim()) && clientId.trim() && !idError && secret;
  const what = merchant ? "密钥没有换" : "商户还没有配置";

  const commit = (confirmationToken?: string) => {
    if (!merchant) return;
    const clientChanged = clientId.trim() !== merchant.clientId;
    setError(null);
    writes.update.mutate(
      {
        requestId: crypto.randomUUID(),
        version: merchant.version,
        label: merchant.label,
        ...(clientChanged ? { clientId: clientId.trim() } : {}),
        secret,
        ...(confirmationToken ? { confirmationToken } : {}),
      },
      {
        onSuccess: () => {
          setPreview(null);
          onClose();
        },
        onError: (failure) => {
          // The impact moved meanwhile: show the new counts, ask again.
          if (failure instanceof MerchantChangeConfirmationError) {
            setPreview(failure.change);
            setNote(failure.message);
            return;
          }
          setPreview(null);
          setError(saveError(failure, what));
        },
      },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A portal's events still bubble up React's tree: not into the 红包
    // form this window was opened from.
    event.stopPropagation();
    if (!valid || busy) return;
    setError(null);
    if (!merchant) {
      writes.create.mutate(
        {
          requestId: crypto.randomUUID(),
          mode: "real",
          label: label.trim(),
          clientId: clientId.trim(),
          secret,
        },
        {
          onSuccess: onClose,
          onError: (failure) => setError(saveError(failure, what)),
        },
      );
      return;
    }
    writes.changeImpact.mutate(undefined, {
      onSuccess: (impact) => {
        if (Object.values(impact.impact).some((count) => count > 0)) {
          setNote(null);
          setPreview(impact);
        } else commit(impact.confirmationToken);
      },
      onError: (failure) => setError(saveError(failure, what)),
    });
  };

  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="32rem"
      nested
      busy={busy}
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {merchant ? "换商户密钥" : "配置商户"}
        </h2>
        <span className="-mr-2 flex shrink-0 items-center gap-1">
          <MerchantGuide />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </Button>
        </span>
      </header>
      <form className="grid gap-3 px-5 pb-5" onSubmit={submit} noValidate>
        <p className="text-sm text-ink-2">
          {merchant
            ? `「${merchant.label}」的 Client ID 或密钥没通过检查。到 Credit 站的集市应用里核对，填上它的密钥。`
            : "用商户发的红包，LDC 从你在 Credit 站的集市应用直接付给领取的人。填上它的 Client ID 和密钥。"}
        </p>
        {!merchant && (
          <Field
            label="商户名称"
            htmlFor={ids.label}
            error={label.trim() ? null : "请填写商户名称"}
            live
          >
            <TextInput
              id={ids.label}
              value={label}
              maxLength={100}
              invalid={!label.trim()}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
        )}
        <Field
          label="Client ID"
          htmlFor={ids.client}
          hint="在 Credit 站的集市应用里查看。"
          error={idError}
          live
        >
          <TextInput
            id={ids.client}
            value={clientId}
            mono
            autoComplete="off"
            spellCheck={false}
            invalid={Boolean(idError)}
            onChange={(event) => setClientId(event.target.value)}
          />
        </Field>
        <Field
          label="商户密钥"
          htmlFor={ids.secret}
          hint="保存后自动检查；密钥不会显示出来。"
        >
          <TextInput
            id={ids.secret}
            type="password"
            value={secret}
            autoComplete="new-password"
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <Reveal show={Boolean(error)}>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Reveal>
        <Reveal show={busy}>
          <p className="loading-sheen text-sm text-ink-2">
            正在保存，存好后会自动检查密钥
          </p>
        </Reveal>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button">
            返回
          </Button>
          <Button
            variant="primary"
            type="submit"
            aria-disabled={!valid || busy || undefined}
            data-disabled={!valid || undefined}
          >
            {busy ? "正在保存…" : "保存"}
          </Button>
        </div>
      </form>
      <ChangeDialog
        preview={preview}
        busy={writes.update.isPending}
        note={note}
        onConfirm={() => commit(preview?.confirmationToken)}
        onCancel={() => {
          setPreview(null);
          setNote(null);
        }}
      />
    </WindowDialog>
  );
}
