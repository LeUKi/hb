import { useAtom, useAtomValue } from "jotai";
import { ExternalLink, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { activities, fixtureCategories } from "../../fixtures/activities";
import type { DrawSim, PaymentSim } from "../../fixtures/hongbao";
import { activityPath } from "../../lib/activity-route";
import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  renderHongbaoImage,
} from "../../lib/hongbao-image";
import {
  audienceFor,
  type ImageAudience,
  type ImageViewer,
  imageInputFor,
  imageSummary,
} from "../../lib/hongbao-image-input";
import {
  claimsAtom,
  drawSimAtom,
  paymentSimAtom,
  sessionAtom,
} from "../../lib/store";
import { Button } from "../ui/button";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { Section, Segmented } from "./controls";

// 内嵌图一览: every sample 红包's forum image side by side, drawn the way a
// forum shows it (an <img>: no scripts, CSS animations run). Production
// picks the variant by the image cookie; here the switches pick it.

type Perspective = "current" | "guest" | "member" | "participant";
type Age = "0" | "15" | "40";

const perspectives: [Perspective, string][] = [
  ["current", "当前身份"],
  ["guest", "未登录"],
  ["member", "已登录 · 没参与"],
  ["participant", "已登录 · 参与过"],
];

const imagePayments: [PaymentSim, string][] = [
  ["auto", "自动"],
  ["confirmed", "已发放"],
  ["pending", "付款处理中"],
  ["reconciling", "正在核对原订单"],
  ["attention", "需要关注"],
];

/** A data URL; `round` makes it new, so its animations play again. */
const svgSource = (svg: string, round: number) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`${svg}<!-- ${round} -->`)}`;

export function ImageGallery({ onClose }: { onClose: () => void }) {
  const session = useAtomValue(sessionAtom);
  const claims = useAtomValue(claimsAtom);
  const [drawSim, setDrawSim] = useAtom(drawSimAtom);
  const [paymentSim, setPaymentSim] = useAtom(paymentSimAtom);
  const [perspective, setPerspective] = useState<Perspective>("current");
  const [age, setAge] = useState<Age>("0");
  const [size, setSize] = useState<"half" | "full">("half");
  // Bumped by 重播: every image reloads and its opening plays again.
  const [round, setRound] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const scale = size === "half" ? 0.5 : 1;

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const imageFor = (id: string) => {
    const activity = activities.find((item) => item.id === id);
    if (!activity) return null;
    const sims = { drawSim, paymentSim, now };
    let audience: ImageAudience;
    let viewer: ImageViewer;
    let draw: DrawSim = drawSim;
    if (perspective === "current") {
      // What production would draw for this session (with the image cookie).
      const record = claims[activity.id];
      audience = session
        ? { signedIn: true, name: session.displayName, record }
        : { signedIn: false };
      viewer = !session ? "guest" : record ? "participant" : "member";
    } else {
      viewer = perspective;
      ({ audience, drawSim: draw } = audienceFor(activity, viewer, sims));
    }
    const input = imageInputFor(activity, audience, {
      ...sims,
      drawSim: draw,
      age: Number(age),
    });
    const query = new URLSearchParams({ viewer });
    if (age !== "0") query.set("age", age);
    return {
      activity,
      input,
      src: svgSource(renderHongbaoImage(input), round),
      href: `${activityPath(activity.id)}/🖼️.svg?${query}`,
    };
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgb(40_8_14/0.32)] backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
      />
      <motion.div
        className="relative flex h-[min(56rem,100%)] w-[min(72rem,100%)] flex-col"
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.18 }}
      >
        <SquirclePlate className="pop-plate" radius={radius.pop} />
        <Squircle radius={radius.pop}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-gallery-title"
            tabIndex={-1}
            className="glass-pop relative flex min-h-0 flex-1 flex-col outline-none"
          >
            <header className="grid gap-3 border-b border-line px-5 pt-4 pb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-0.5">
                  <h2
                    id="image-gallery-title"
                    className="text-lg font-semibold text-ink"
                  >
                    内嵌图一览
                  </h2>
                  <p className="text-xs text-ink-3">
                    和论坛里一样用 &lt;img&gt; 显示。生产按图片 Cookie
                    决定画哪一种；没有 Cookie、 浏览器拦截第三方 Cookie
                    或作者本人看到的都是未登录的图。
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭"
                  className="-mr-2 shrink-0"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                <Section title="视角">
                  <Segmented
                    value={perspective}
                    onChange={setPerspective}
                    options={perspectives}
                  />
                </Section>
                <Section title="生成后">
                  <Segmented
                    value={age}
                    onChange={setAge}
                    options={[
                      ["0", "刚生成"],
                      ["15", "15 秒"],
                      ["40", "40 秒"],
                    ]}
                  />
                </Section>
                <Section title="大小">
                  <Segmented
                    value={size}
                    onChange={setSize}
                    options={[
                      ["half", "一半"],
                      ["full", "原大"],
                    ]}
                  />
                </Section>
                <Section title="限时开奖">
                  <Segmented
                    value={drawSim}
                    onChange={setDrawSim}
                    options={[
                      ["waiting", "未开奖"],
                      ["won", "中"],
                      ["lost", "未中"],
                    ]}
                  />
                </Section>
                <Section title="发放状态">
                  <Segmented
                    value={paymentSim}
                    onChange={setPaymentSim}
                    options={imagePayments}
                  />
                </Section>
                <Section title="开包动画">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRound((value) => value + 1)}
                  >
                    <RotateCcw />
                    重播
                  </Button>
                </Section>
              </div>
            </header>
            <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
              {fixtureCategories.map((category) => (
                <section key={category.mode} className="mb-6 grid gap-3">
                  <h3 className="text-sm font-medium text-ink-2">
                    {category.label}
                  </h3>
                  <div
                    className="grid gap-x-4 gap-y-5"
                    style={{
                      gridTemplateColumns: `repeat(auto-fill, minmax(${IMAGE_WIDTH * scale}px, 1fr))`,
                    }}
                  >
                    {activities
                      .filter(
                        (activity) =>
                          activity.mode === category.mode && !activity.draft,
                      )
                      .map((activity) => {
                        const image = imageFor(activity.id);
                        if (!image) return null;
                        return (
                          <figure
                            key={activity.id}
                            className="grid content-start justify-items-center gap-1.5"
                          >
                            <img
                              src={image.src}
                              width={IMAGE_WIDTH * scale}
                              height={IMAGE_HEIGHT * scale}
                              alt={`${activity.author.displayName}的红包：${activity.title}`}
                            />
                            <figcaption className="grid justify-items-center gap-0.5 text-center text-xs">
                              <span className="text-ink">
                                {activity.situation} · {activity.title}
                              </span>
                              <span className="text-ink-3">
                                {imageSummary(image.input)}
                              </span>
                              <a
                                href={image.href}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
                              >
                                新标签页
                                <ExternalLink
                                  className="size-3"
                                  aria-hidden="true"
                                />
                              </a>
                            </figcaption>
                          </figure>
                        );
                      })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </Squircle>
      </motion.div>
    </div>
  );
}
