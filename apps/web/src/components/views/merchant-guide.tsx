import { ArrowUpRight, CircleHelp } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import apiImage from "../../assets/ldc-guide/ldc-app-api.webp";
import urlsImage from "../../assets/ldc-guide/ldc-app-urls.webp";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Squircle } from "../ui/squircle";

/** Where LINUX DO Credit lists (and creates) one's 集市应用. */
const CREDIT_APPS_URL = "https://credit.linux.do/merchant";
/** What LDC asks for both URLs; this site uses neither. */
const SUGGESTED_URL = "http://localhost:3000/";

function Step({
  n,
  title,
  children,
  image,
}: {
  n: number;
  title: string;
  children: ReactNode;
  image: { src: string; width: number; height: number; alt: string };
}) {
  return (
    <section className="grid gap-2.5">
      <h3 className="text-base font-semibold text-ink">
        第 {n} 步：{title}
      </h3>
      {children}
      {/* LDC's own screens, at their size or smaller: never blown up. */}
      <Squircle radius={12}>
        <img
          src={image.src}
          width={image.width}
          height={image.height}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          className="block h-auto max-w-full border border-line"
        />
      </Squircle>
    </section>
  );
}

/**
 * 怎么填: where the 集市应用 comes from, beside the form that asks for it —
 * open LINUX DO Credit's 集市应用 page and create one (any name, the
 * suggested URL for both addresses), then copy its Client ID and Client
 * Secret over. A window dialog with LDC's own screens (the Client ID in
 * them masked).
 */
export function MerchantGuide() {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const close = () => setOpen(false);
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        aria-haspopup="dialog"
        className="-mr-1 shrink-0 text-ink-2"
        onClick={() => setOpen(true)}
      >
        <CircleHelp />
        怎么填
      </Button>
      <WindowDialog
        open={open}
        onClose={close}
        labelledBy={titleId}
        width="38rem"
      >
        <div className="grid gap-6 p-5">
          <div className="grid gap-1">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              在 Credit 站创建集市应用
            </h2>
            <p className="text-sm text-ink-2">
              用商户发的红包，LDC 从你的集市应用付出。在 LINUX DO Credit
              建一个集市应用，再把它的 Client ID 和 Client Secret 填到这里。
            </p>
          </div>
          <Step
            n={1}
            title="创建集市应用"
            image={{
              src: urlsImage,
              width: 576,
              height: 577,
              alt: "Credit 站的集市应用信息窗口：应用名称填了 meme，应用主页 URL 和通知 URL 都填了 http://localhost:3000/",
            }}
          >
            <p className="text-sm text-ink-2">
              打开 LINUX DO Credit 的集市应用页，点右上角的“创建应用”。
            </p>
            <div>
              <ButtonLink
                href={CREDIT_APPS_URL}
                variant="secondary"
                className="gap-1.5"
              >
                打开 credit.linux.do/merchant
                <ArrowUpRight aria-hidden="true" />
              </ButtonLink>
            </div>
            <p className="text-sm text-ink-2">
              应用名称随意填写；应用主页 URL 和通知 URL
              都填下面这个地址，其余几项留空。本站不用这两个地址，填它就行。
            </p>
            <div className="flex min-w-0 items-center gap-1">
              <Squircle radius={10}>
                <span className="inline-flex h-8 min-w-0 items-center bg-fill px-3 font-mono text-sm text-ink select-all">
                  {SUGGESTED_URL}
                </span>
              </Squircle>
              <CopyButton value={SUGGESTED_URL} label="建议地址" />
            </div>
          </Step>
          <Step
            n={2}
            title="复制 API 配置"
            image={{
              src: apiImage,
              width: 346,
              height: 470,
              alt: "Credit 站的集市应用页：右侧“API 配置”里的 Client ID 和 Client Secret",
            }}
          >
            <p className="text-sm text-ink-2">
              建好后，在集市应用页右侧的“API 配置”里：Client ID 填到“Client
              ID”，Client Secret 填到“商户密钥”。
            </p>
          </Step>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              知道了
            </Button>
          </div>
        </div>
      </WindowDialog>
    </>
  );
}
