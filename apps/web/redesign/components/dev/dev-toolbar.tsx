import { PAYMENT_LABELS } from "@hb/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { ChevronUp, FlaskConical, Images, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { activities, fixtureCategories } from "../../fixtures/activities";
import type { PaymentSim } from "../../fixtures/hongbao";
import {
  type MerchantSim,
  merchantSimLabels,
  merchants,
} from "../../fixtures/merchants";
import { demoPayments } from "../../fixtures/payments";
import { sampleInputs } from "../../fixtures/redemption";
import { type IdentityKind, identityLabels } from "../../fixtures/session";
import { activityCode } from "../../lib/activity-route";
import { sampleAuthErrors } from "../../lib/auth-errors";
import { resetFailures } from "../../lib/sim";
import {
  drawSimAtom,
  framePreviewAtom,
  identityCheckSimAtom,
  identityKindAtom,
  identityRetriedAtom,
  merchantSimAtom,
  motionPrefAtom,
  type PageLoadSim,
  pageLoadSimAtom,
  paymentSimAtom,
  resetDataAtom,
  type SubmitSim,
  simKeyboardAtom,
  slowBootAtom,
  squircleModeAtom,
  submitSimAtom,
} from "../../lib/store";
import { messageAtom, startDraftAtom, unconfirmedAtom } from "../omnibox/state";
import {
  focusOmniboxInput,
  useOmniboxController,
} from "../omnibox/use-omnibox-controller";
import {
  radius,
  Squircle,
  SquirclePlate,
  supportsCornerShape,
} from "../ui/squircle";
import { Section, Segmented } from "./controls";
import { ImageGallery } from "./image-gallery";

// Prototype-only controls. Lives on the desktop backdrop, outside the window,
// and is never imported by promotable components.

export function DevToolbar() {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useAtom(identityKindAtom);
  const [identityCheck, setIdentityCheck] = useAtom(identityCheckSimAtom);
  const setIdentityRetried = useSetAtom(identityRetriedAtom);
  const [frame, setFrame] = useAtom(framePreviewAtom);
  const [motionPref, setMotionPref] = useAtom(motionPrefAtom);
  const [squircleMode, setSquircleMode] = useAtom(squircleModeAtom);
  const [slowBoot, setSlowBoot] = useAtom(slowBootAtom);
  const [simKeyboard, setSimKeyboard] = useAtom(simKeyboardAtom);
  const [drawSim, setDrawSim] = useAtom(drawSimAtom);
  const [paymentSim, setPaymentSim] = useAtom(paymentSimAtom);
  const [merchantSim, setMerchantSim] = useAtom(merchantSimAtom);
  const [pageLoad, setPageLoad] = useAtom(pageLoadSimAtom);
  const [submit, setSubmit] = useAtom(submitSimAtom);
  const resetData = useSetAtom(resetDataAtom);
  const setDraft = useSetAtom(startDraftAtom);
  const setMessage = useSetAtom(messageAtom);
  const setUnconfirmed = useSetAtom(unconfirmedAtom);
  const navigate = useNavigate();
  const router = useRouter();
  const { leaveTo } = useOmniboxController();
  const [gallery, setGallery] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeGallery = useCallback(() => {
    setGallery(false);
    toggleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === "D" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        target?.tagName !== "TEXTAREA" &&
        target?.tagName !== "INPUT"
      )
        setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const samples = sampleInputs(window.location.origin);
  const groups = [...new Set(samples.map((sample) => sample.group))];

  return (
    <div className="fixed bottom-3 left-3 z-[60] flex flex-col items-start gap-2 max-sm:top-1/2 max-sm:bottom-auto max-sm:left-0 max-sm:-translate-y-1/2">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ y: 8 }}
            animate={{ y: 0 }}
            exit={{ y: 8 }}
            transition={{ duration: 0.16 }}
            className="relative flex max-h-[min(40rem,calc(100dvh-5rem))] w-[min(21rem,calc(100vw-1.5rem))] flex-col max-sm:ml-3"
          >
            <SquirclePlate
              className="pop-plate"
              radius={radius.pop}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            />
            <Squircle radius={radius.pop}>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="glass-pop relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto p-4"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">
                    原型控制 · 第三步
                  </p>
                  <span className="text-xs text-ink-3">Shift + D</span>
                </div>
                <Section title="红包页（按类型和状况，点击打开）">
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
                    {fixtureCategories.map((category) => (
                      <div
                        key={category.mode}
                        className="grid grid-cols-[minmax(0,1fr)] gap-0.5"
                      >
                        <p className="text-[11px] font-medium text-ink-2">
                          {category.label}
                        </p>
                        {activities
                          .filter((activity) => activity.mode === category.mode)
                          .map((activity) => (
                            <Squircle key={activity.id} radius={9}>
                              <button
                                type="button"
                                onClick={() => {
                                  setOpen(false);
                                  void leaveTo({
                                    to: "activity",
                                    id: activity.id,
                                  });
                                }}
                                className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-fill-2"
                              >
                                <span className="shrink-0 text-ink">
                                  {activity.situation}
                                </span>
                                <span className="ml-auto min-w-0 truncate text-ink-3">
                                  {activity.title}
                                </span>
                              </button>
                            </Squircle>
                          ))}
                      </div>
                    ))}
                  </div>
                </Section>
                <Section title="页面（第三步，点击打开）">
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                    {pageLinks().map((link) => (
                      <Squircle key={link.href} radius={9}>
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            void navigate({ to: link.href });
                          }}
                          className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-fill-2"
                        >
                          <span className="shrink-0 text-ink">
                            {link.label}
                          </span>
                          <span className="ml-auto min-w-0 truncate font-mono text-ink-3">
                            {link.path}
                          </span>
                        </button>
                      </Squircle>
                    ))}
                  </div>
                </Section>
                <Section title="内嵌图">
                  <Squircle radius={10}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setGallery(true);
                      }}
                      className="inline-flex h-8 w-full items-center justify-center gap-1.5 bg-fill-2 text-xs text-ink hover:bg-line-strong"
                    >
                      <Images className="size-3.5" />
                      内嵌图一览…
                    </button>
                  </Squircle>
                </Section>
                <Section title="身份">
                  <Segmented<IdentityKind>
                    value={identity}
                    onChange={setIdentity}
                    options={
                      Object.entries(identityLabels) as [IdentityKind, string][]
                    }
                  />
                </Section>
                <Section title="身份检查">
                  <Segmented<"ok" | "failed">
                    value={identityCheck}
                    onChange={(value) => {
                      setIdentityCheck(value);
                      // Each switch to 失败 plays the failure again.
                      setIdentityRetried(false);
                    }}
                    options={[
                      ["ok", "正常"],
                      ["failed", "失败"],
                    ]}
                  />
                </Section>
                <Section title="窗口尺寸">
                  <Segmented
                    value={frame}
                    onChange={setFrame}
                    options={[
                      ["auto", "跟随浏览器"],
                      ["phone", "手机"],
                      ["tablet", "平板"],
                    ]}
                  />
                </Section>
                <Section title="模拟手机键盘">
                  <Segmented
                    value={simKeyboard ? "on" : "off"}
                    onChange={(value) => setSimKeyboard(value === "on")}
                    options={[
                      ["off", "关"],
                      ["on", "开（手机窗口里输入时）"],
                    ]}
                  />
                </Section>
                <Section title="动效">
                  <Segmented
                    value={motionPref}
                    onChange={setMotionPref}
                    options={[
                      ["system", "跟随系统"],
                      ["reduce", "减少动态效果"],
                    ]}
                  />
                </Section>
                <Section title="超椭圆画法">
                  {supportsCornerShape && (
                    <Segmented<"auto" | "fallback">
                      value={squircleMode}
                      onChange={setSquircleMode}
                      options={[
                        ["auto", "浏览器自己画"],
                        ["fallback", "裁切 + 描边（Safari、Firefox）"],
                      ]}
                    />
                  )}
                  <p className="text-xs text-ink-3">
                    {supportsCornerShape
                      ? "这个浏览器支持 CSS corner-shape。切到“裁切 + 描边”，看 Safari、Firefox 里的样子。"
                      : "这个浏览器不支持 CSS corner-shape：超椭圆靠裁切，描边沿着同一条路径画。"}
                  </p>
                </Section>
                <Section title="限时开奖">
                  <Segmented
                    value={drawSim}
                    onChange={setDrawSim}
                    options={[
                      ["waiting", "未开奖"],
                      ["won", "已开奖 · 中"],
                      ["lost", "已开奖 · 未中"],
                    ]}
                  />
                </Section>
                <Section title="发放状态">
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [["auto", "自动"], ...Object.entries(PAYMENT_LABELS)] as [
                        PaymentSim,
                        string,
                      ][]
                    ).map(([key, label]) => (
                      <Squircle key={key} radius={9}>
                        <button
                          type="button"
                          aria-pressed={paymentSim === key}
                          onClick={() => setPaymentSim(key)}
                          className={`h-7 px-2.5 text-xs transition-colors ${
                            paymentSim === key
                              ? "bg-white font-medium text-ink raised"
                              : "bg-fill-2 text-ink-2 hover:text-ink"
                          }`}
                        >
                          {label}
                        </button>
                      </Squircle>
                    ))}
                  </div>
                </Section>
                <Section title="登录回调（模拟 LINUX DO 带回的错误）">
                  <div className="flex flex-wrap gap-1.5">
                    {sampleAuthErrors.map(([code, label]) => (
                      <Squircle key={code} radius={9}>
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            const { pathname } = router.history.location;
                            router.history.push(
                              `${pathname}?authError=${code}`,
                            );
                          }}
                          className="h-7 bg-fill-2 px-2.5 text-xs text-ink-2 transition-colors hover:text-ink"
                        >
                          {label}
                        </button>
                      </Squircle>
                    ))}
                  </div>
                </Section>
                <Section title="页面数据（第三步的页面）">
                  <Segmented<PageLoadSim>
                    value={pageLoad}
                    onChange={setPageLoad}
                    options={[
                      ["normal", "正常"],
                      ["slow", "加载慢"],
                      ["error", "读取失败"],
                      ["stale", "刷新失败"],
                      ["more-error", "加载更多失败"],
                    ]}
                  />
                </Section>
                <Section title="提交结果（领取 / 报名、保存）">
                  <Segmented<SubmitSim>
                    value={submit}
                    onChange={(value) => {
                      // Each submission fails once again under the new setting.
                      resetFailures();
                      setSubmit(value);
                    }}
                    options={[
                      ["ok", "正常"],
                      ["failed", "失败"],
                      ["unknown", "结果未知"],
                      ["throttled", "太频繁"],
                      ["conflict", "版本冲突"],
                    ]}
                  />
                </Section>
                <Section title="LDC 商户（/merchant、发红包）">
                  <Segmented<MerchantSim>
                    value={merchantSim}
                    onChange={(value) => {
                      // The switch wins over a check played on /merchant.
                      for (const merchant of merchants) delete merchant.check;
                      setMerchantSim(value);
                    }}
                    options={
                      Object.entries(merchantSimLabels) as [
                        MerchantSim,
                        string,
                      ][]
                    }
                  />
                </Section>
                <Section title="启动加载">
                  <div className="flex gap-2">
                    <Squircle radius={10}>
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 bg-fill-2 text-xs text-ink hover:bg-line-strong"
                      >
                        <RotateCcw className="size-3.5" />
                        重放加载
                      </button>
                    </Squircle>
                    <Segmented
                      value={slowBoot ? "slow" : "normal"}
                      onChange={(value) => setSlowBoot(value === "slow")}
                      options={[
                        ["normal", "正常"],
                        ["slow", "慢速"],
                      ]}
                    />
                  </div>
                </Section>
                <Section title="示例输入（点击填入起始页）">
                  <div className="grid gap-2">
                    {groups.map((group) => (
                      <div key={group} className="grid gap-1">
                        <p className="text-[11px] text-ink-3">{group}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {samples
                            .filter((sample) => sample.group === group)
                            .map((sample) => (
                              <Squircle key={sample.label} radius={9}>
                                <button
                                  type="button"
                                  title={sample.value}
                                  onClick={() => {
                                    setDraft(sample.value);
                                    setMessage(null);
                                    // A new start-page input: a lookup
                                    // waiting on 再次确认 is dropped.
                                    setUnconfirmed((current) => ({
                                      ...current,
                                      lookup: null,
                                    }));
                                    setOpen(false);
                                    void navigate({ to: "/" }).then(() =>
                                      requestAnimationFrame(() =>
                                        focusOmniboxInput(),
                                      ),
                                    );
                                  }}
                                  className="h-7 bg-fill-2 px-2.5 text-xs text-ink hover:bg-line-strong"
                                >
                                  {sample.label}
                                </button>
                              </Squircle>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
                <Squircle radius={10}>
                  <button
                    type="button"
                    onClick={() => {
                      resetData();
                      setMessage(null);
                      setUnconfirmed({ lookup: null, claims: {} });
                    }}
                    className="h-8 text-xs text-ink-2 hover:bg-fill-2"
                  >
                    重置参与记录与最近输入
                  </button>
                </Squircle>
              </motion.div>
            </Squircle>
          </motion.div>
        )}
      </AnimatePresence>
      <Squircle radius={11}>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex h-8 items-center gap-1.5 bg-black/45 px-3 text-xs text-white squircle-ring [--sq-ring:rgb(255_255_255/0.15)] backdrop-blur transition-colors hover:bg-black/60 max-sm:ml-1.5 max-sm:px-2"
        >
          <FlaskConical className="size-3.5" />
          <span className="max-sm:hidden">原型</span>
          <ChevronUp
            className={`size-3.5 transition-transform max-sm:hidden ${open ? "" : "rotate-180"}`}
          />
        </button>
      </Squircle>
      {gallery &&
        createPortal(<ImageGallery onClose={closeGallery} />, document.body)}
    </div>
  );
}

const READING = "c2b7f1a4-5d3e-4f6a-9b8c-1d2e3f4a5b6c";
const NEXT_DRAW = "c5d8e2a1-7b4c-4d9e-8f1a-2b3c4d5e6f7a";

/** The third step's pages, including the ones only reachable from a row. */
function pageLinks() {
  const reading = `/🧧/${activityCode(READING)}`;
  const paused = demoPayments().find(
    (payment) => payment.state === "attention",
  );
  const repair = demoPayments().find((payment) => payment.repairable);
  return [
    { label: "发红包", path: "/new", href: "/new" },
    { label: "红包记录", path: "/history", href: "/history" },
    { label: "红包广场", path: "/square", href: "/square" },
    { label: "账号资料", path: "/me", href: "/me" },
    { label: "LDC 商户配置", path: "/merchant", href: "/merchant" },
    { label: "付款记录", path: "/payments", href: "/payments" },
    {
      label: "付款详情 · 发送暂停",
      path: "/payments/…",
      href: `/payments/${paused?.id ?? ""}`,
    },
    ...(repair
      ? [
          {
            label: "付款详情 · 等你更新密钥",
            path: "/payments/…",
            href: `/payments/${repair.id}`,
          },
        ]
      : []),
    { label: "网站管理", path: "/admin", href: "/admin" },
    { label: "帮助", path: "/help", href: "/help" },
    { label: "我发的红包（作者视角）", path: "/🧧/…", href: reading },
    { label: "编辑 · 进行中", path: "/🧧/…/📝", href: `${reading}/📝` },
    { label: "尝试统计", path: "/🧧/…/📊", href: `${reading}/📊` },
    { label: "这个红包的付款", path: "/🧧/…/🧾", href: `${reading}/🧾` },
    {
      label: "编辑 · 草稿",
      path: "/🧧/…/📝",
      href: `/🧧/${activityCode(NEXT_DRAW)}/📝`,
    },
  ];
}
