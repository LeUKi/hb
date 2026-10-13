import type { PaymentState, PublicActivity } from ".";
import { decodeActivityEmoji, encodeActivityEmoji } from "./ecoji-v2";

export const ACTIVITY_IMAGE_WIDTH = 420;
export const ACTIVITY_IMAGE_HEIGHT = 560;
export const DEFAULT_ACTIVITY_IMAGE_TIME_ZONE = "Asia/Shanghai";

export type ActivityImageRenderState =
  | "neutral"
  | "active"
  | "registered"
  | "drawing"
  | "claimed"
  | "ended"
  | "not_won"
  | "loading"
  | "pending"
  | "error"
  | "unavailable";

export type ActivityImagePaymentStatus = Extract<
  PaymentState,
  "pending" | "sending" | "reconciling" | "waiting" | "confirmed" | "attention"
> | null;

export type ActivityImagePresentation = {
  id?: string;
  title: string;
  sender: string;
  state: ActivityImageRenderState;
  sealLabel: string;
  quantityText?: string | null;
  amount?: string | null;
  statusText?: string | null;
  claimedAt?: string | Date | null;
  updatedAt: string | Date;
  now?: string | Date;
  timeZone?: string;
  animated?: boolean;
  revealPhase?: "closed" | "opening" | "open" | "closing";
  instanceId?: string;
  publicFallback?: boolean;
};

export type ActivityImageViewerState =
  | { kind: "public"; canParticipate?: false }
  | { kind: "eligible"; action: "claim" | "register" }
  | { kind: "registered"; registeredAt: string | Date }
  | { kind: "drawing" }
  | {
      kind: "claimed";
      amount: string;
      claimedAt: string | Date;
      paymentStatus?: ActivityImagePaymentStatus;
    }
  | { kind: "ended" }
  | { kind: "not_won" }
  | { kind: "loading" | "pending" | "error" | "unavailable" };

export type ActivityImageEmbedInput = {
  activityHref: string;
  imageHref: string;
  reducedImageHref: string;
  fallbackImageHref: string;
  title: string;
  sender: string;
};

export type ActivityImagePreferences = {
  timeZone: string;
  recentRequest: null | {
    activityId: string;
    requestedAt: string;
    available: boolean;
  };
};

const UPPER_COVER =
  "M10 36c0-15.5 12.5-28 28-28h344c15.5 0 28 12.5 28 28v290c-72 40-138.6 60-200 60S82 366 10 326V36Z";
const LOWER_COVER =
  "M10 326c72 40 138.6 60 200 60s128-20 200-60v202c0 13.3-10.7 24-24 24H34c-13.3 0-24-10.7-24-24Z";
const COVER_SEAM = "M10 326c72 40 138.6 60 200 60s128-20 200-60";
const VALID_TIME_ZONE_CACHE = new Map<string, boolean>();
const IMAGE_TIME_ZONE_IDENTIFIER_RE =
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export function isImageTimeZone(
  value: string | null | undefined,
): value is string {
  if (!value || value.length > 80) return false;
  if (!IMAGE_TIME_ZONE_IDENTIFIER_RE.test(value)) return false;
  if (value === "Asia/Shanghai" || value === "UTC") return true;
  const cached = VALID_TIME_ZONE_CACHE.get(value);
  if (cached !== undefined) return cached;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    if (VALID_TIME_ZONE_CACHE.size > 128) {
      const oldest = VALID_TIME_ZONE_CACHE.keys().next().value;
      if (oldest !== undefined) VALID_TIME_ZONE_CACHE.delete(oldest);
    }
    VALID_TIME_ZONE_CACHE.set(value, true);
    return true;
  } catch {
    if (VALID_TIME_ZONE_CACHE.size > 128) {
      const oldest = VALID_TIME_ZONE_CACHE.keys().next().value;
      if (oldest !== undefined) VALID_TIME_ZONE_CACHE.delete(oldest);
    }
    VALID_TIME_ZONE_CACHE.set(value, false);
    return false;
  }
}

export function activityImageUrl(
  activityId: string,
  origin: string,
  options: {
    reducedMotion?: boolean;
    timeZone?: string;
    fallback?: boolean;
  } = {},
) {
  const path = `/e/${encodeActivityEmoji(activityId)}/live.svg`;
  const url = new URL(path, origin);
  if (options.reducedMotion) url.searchParams.set("motion", "reduced");
  if (options.fallback) url.searchParams.set("fallback", "public");
  if (options.timeZone && isImageTimeZone(options.timeZone))
    url.searchParams.set("tz", options.timeZone);
  return `${url.origin}${path}${url.search}`;
}

export function createActivityImageEmbed(input: ActivityImageEmbedInput) {
  const activityHref = safeGeneratedUrl(input.activityHref);
  const imageHref = safeGeneratedUrl(input.imageHref);
  const reducedImageHref = safeGeneratedUrl(input.reducedImageHref);
  const fallbackImageHref = safeGeneratedUrl(input.fallbackImageHref);
  const alt = `${normalizeText(input.sender, "活动发起人")} 的活动红包：${normalizeText(
    input.title,
    "未命名活动",
  )}`;
  return [
    `<a href="${escapeXml(activityHref)}">`,
    "  <picture>",
    `    <source type="image/svg+xml" srcset="${escapeXml(reducedImageHref)} 1x" media="(prefers-reduced-motion: reduce)">`,
    `    <source type="image/svg+xml" srcset="${escapeXml(imageHref)} 1x">`,
    `    <img src="${escapeXml(fallbackImageHref)}" width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" alt="${escapeXml(
      alt,
    )}">`,
    "  </picture>",
    "</a>",
  ].join("\n");
}

export function activityImagePresentation(input: {
  activity: PublicActivity;
  viewer?: ActivityImageViewerState;
  updatedAt: string | Date;
  now?: string | Date;
  animated?: boolean;
  timeZone?: string;
  instanceId?: string;
  publicFallback?: boolean;
}): ActivityImagePresentation {
  const viewer = input.publicFallback
    ? { kind: "public" as const }
    : input.viewer;
  const sender =
    input.activity.author.displayName ||
    input.activity.author.username ||
    "活动发起人";
  if (!viewer || viewer.kind === "public") {
    const publicDrawing =
      !input.publicFallback && input.activity.draw?.state === "settling";
    return {
      id: input.activity.id,
      title: input.activity.title || "未命名活动",
      sender,
      state: input.publicFallback
        ? "neutral"
        : publicDrawing
          ? "drawing"
          : input.activity.status === "active"
            ? "active"
            : "ended",
      sealLabel: input.publicFallback
        ? "查看活动"
        : publicDrawing
          ? "开奖中"
          : input.activity.status === "active"
            ? "查看"
            : "已结束",
      quantityText: input.publicFallback
        ? null
        : quantityDisplay(input.activity),
      updatedAt: input.updatedAt,
      now: input.now,
      animated: input.animated,
      timeZone: input.timeZone,
      instanceId: input.instanceId,
      publicFallback: input.publicFallback,
    };
  }
  if (viewer.kind === "eligible") {
    return {
      id: input.activity.id,
      title: input.activity.title || "未命名活动",
      sender,
      state: "active",
      sealLabel: viewer.action === "register" ? "报名" : "开",
      quantityText: quantityDisplay(input.activity),
      updatedAt: input.updatedAt,
      now: input.now,
      animated: input.animated,
      timeZone: input.timeZone,
      instanceId: input.instanceId,
    };
  }
  if (viewer.kind === "claimed") {
    return {
      id: input.activity.id,
      title: input.activity.title || "未命名活动",
      sender,
      state: "claimed",
      sealLabel: "开",
      amount: `${viewer.amount} LDC`,
      statusText: paymentStatusText(viewer.paymentStatus ?? null),
      claimedAt: viewer.claimedAt,
      updatedAt: input.updatedAt,
      now: input.now,
      animated: input.animated,
      timeZone: input.timeZone,
      instanceId: input.instanceId,
    };
  }
  const state = viewer.kind;
  return {
    id: input.activity.id,
    title: input.activity.title || "未命名活动",
    sender,
    state,
    sealLabel:
      state === "registered"
        ? "已报名"
        : state === "drawing"
          ? "开奖中"
          : state === "not_won"
            ? "未中奖"
            : state === "pending"
              ? "处理中"
              : state === "loading"
                ? "读取中"
                : state === "error"
                  ? "读取失败"
                  : state === "unavailable"
                    ? "不可用"
                    : "已结束",
    statusText: state === "registered" ? "已报名，等待开奖" : undefined,
    updatedAt: input.updatedAt,
    now: input.now,
    animated: input.animated,
    timeZone: input.timeZone,
    instanceId: input.instanceId,
  };
}

export function renderActivityImage(input: ActivityImagePresentation): string {
  const now = safeDate(input.now, null) ?? new Date();
  const updatedAt = safeDate(input.updatedAt, null) ?? now;
  const timeZone = isImageTimeZone(input.timeZone)
    ? input.timeZone
    : DEFAULT_ACTIVITY_IMAGE_TIME_ZONE;
  const scope = scopeId(input.instanceId ?? input.id ?? "activity");
  const animated = input.animated !== false;
  const state = input.state;
  const neutralPlaceholder = state === "neutral" && !input.publicFallback;
  const title = neutralPlaceholder
    ? normalizeText(input.title, "")
    : normalizeText(input.title, "未命名活动");
  const sender = clampText(
    neutralPlaceholder
      ? normalizeText(input.sender, "")
      : normalizeText(input.sender, "活动发起人"),
    14,
  );
  const ageSeconds = Math.max(0, (now.getTime() - updatedAt.getTime()) / 1000);
  const active =
    state === "active" ||
    state === "registered" ||
    state === "drawing" ||
    state === "loading" ||
    state === "pending";
  const desc = imageDescription({
    ...input,
    sender,
    state,
    timeZone,
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" viewBox="0 0 ${ACTIVITY_IMAGE_WIDTH} ${ACTIVITY_IMAGE_HEIGHT}" role="img" aria-labelledby="${scope}-title ${scope}-desc" data-scope="${scope}" data-state="${escapeXml(state)}"${active ? dataAttributes(updatedAt, timeZone) : ""}>
  <title id="${scope}-title">${escapeXml(title)}</title>
  <desc id="${scope}-desc">${escapeXml(desc)}</desc>
  ${renderDefs(scope)}
  ${renderBody({ ...input, title, sender, state, timeZone, updatedAt, ageSeconds, animated, scope })}
  ${renderSharedStyles(scope)}
</svg>`;
}

function imageDescription(
  input: ActivityImagePresentation & {
    sender: string;
    state: ActivityImageRenderState;
    timeZone: string;
  },
) {
  const parts = [
    input.sender ? `${input.sender} 的活动红包图片` : "活动红包图片",
  ];
  if (input.publicFallback || input.state === "neutral")
    return parts[0] ?? "活动红包图片";

  if (input.state === "claimed") {
    parts.push(`状态：${input.statusText ?? "已领取"}`);
    parts.push(`金额：${displayAmountText(input.amount)}`);
    const claimedAt = safeDate(input.claimedAt, null);
    if (claimedAt)
      parts.push(
        `领取时间：${snapshotDisplay(claimedAt, input.timeZone, true)}`,
      );
    return parts.join("；");
  }

  const stateText =
    input.statusText ??
    statusForActive(input.state) ??
    input.sealLabel ??
    stateLabel(input.state);
  if (stateText) parts.push(`状态：${stateText}`);
  if (input.quantityText) parts.push(`数量：${input.quantityText}`);
  return parts.join("；");
}

function stateLabel(state: ActivityImageRenderState) {
  if (state === "ended") return "已结束";
  if (state === "not_won") return "未中奖";
  if (state === "error") return "读取失败";
  if (state === "unavailable") return "不可用";
  if (state === "loading") return "读取中";
  if (state === "pending") return "处理中";
  if (state === "drawing") return "开奖中";
  if (state === "registered") return "已报名，等待开奖";
  if (state === "active") return "查看";
  return null;
}

function renderBody(
  input: ActivityImagePresentation & {
    title: string;
    sender: string;
    state: ActivityImageRenderState;
    timeZone: string;
    updatedAt: Date;
    ageSeconds: number;
    animated: boolean;
    scope: string;
  },
) {
  if (input.publicFallback || input.state === "neutral")
    return renderNeutral(input);
  if (input.state === "claimed") {
    if (input.revealPhase === "closed")
      return renderActive({
        ...input,
        state: "active",
        quantityText: input.statusText ?? "领取结果已确认",
      });
    return renderClaimed({
      ...input,
      animated: input.revealPhase === "open" ? false : input.animated,
    });
  }
  if (
    input.state === "ended" ||
    input.state === "not_won" ||
    input.state === "error" ||
    input.state === "unavailable"
  )
    return renderEnded(input);
  return renderActive(input);
}

function renderDefs(scope: string) {
  return `<defs>
    <clipPath id="${scope}-packetClip"><rect x="10" y="8" width="400" height="544" rx="28"/></clipPath>
    <clipPath id="${scope}-sealClip"><circle cx="210" cy="388" r="58"/></clipPath>
    <filter id="${scope}-softShadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#4d3027" flood-opacity=".14"/></filter>
  </defs>`;
}

function renderActive(
  input: ActivityImagePresentation & {
    title: string;
    sender: string;
    timeZone: string;
    updatedAt: Date;
    ageSeconds: number;
    animated: boolean;
    scope: string;
  },
) {
  const text = input.quantityText ?? statusForActive(input.state);
  const sealSize =
    Array.from(input.sealLabel).length > 1 ? " seal-text-compact" : "";
  return `${renderActiveStyles(input.scope, input.ageSeconds, input.animated)}
  <g class="packet" filter="url(#${input.scope}-softShadow)">
    <rect x="10" y="8" width="400" height="544" rx="28" fill="#c94b37"/>
    <path d="${UPPER_COVER}" fill="#d65b43"/>
    <path d="${COVER_SEAM}" fill="none" stroke="#a83f30" stroke-opacity=".35" stroke-width="1.5"/>
    ${renderAging(input.scope)}
    <text x="210" y="125" class="sender">${escapeXml(input.sender)}</text>
    ${renderTitleLines(input.title)}
    <text x="210" y="262" class="freshness-warning">数据可能过期，打开活动查看最新状态</text>
    <text x="210" y="262" class="stale-prompt">数据已过期，打开活动查看最新状态</text>
    ${renderGoldParticles(input.animated)}
    <g class="seal">
      <circle cx="210" cy="388" r="58" fill="#dfbd7c" stroke="#8b6435" stroke-opacity=".24" stroke-width="1"/>
      ${renderSealWear(input.scope)}
      <text x="210" y="388" class="seal-text${sealSize}">${escapeXml(input.sealLabel)}</text>
    </g>
    ${text ? `<text x="210" y="495" class="data-row">${escapeXml(text)}</text>` : ""}
    <text x="210" y="522" class="snapshot-time">数据截至 ${escapeXml(snapshotDisplay(input.updatedAt, input.timeZone))}</text>
  </g>`;
}

function renderNeutral(
  input: ActivityImagePresentation & {
    title: string;
    sender: string;
    scope: string;
  },
) {
  const sealSize =
    Array.from(input.sealLabel).length > 1 ? " seal-text-compact" : "";
  return `<g class="packet neutral-packet" filter="url(#${input.scope}-softShadow)">
    <rect x="10" y="8" width="400" height="544" rx="28" fill="#c94b37"/>
    <path d="${UPPER_COVER}" fill="#d65b43"/>
    <path d="${COVER_SEAM}" fill="none" stroke="#a83f30" stroke-opacity=".35" stroke-width="1.5"/>
    ${input.sender ? `<text x="210" y="125" class="sender">${escapeXml(input.sender)}</text>` : ""}
    ${input.title ? renderTitleLines(input.title) : ""}
    <g class="seal">
      <circle cx="210" cy="388" r="58" fill="#dfbd7c" stroke="#8b6435" stroke-opacity=".24" stroke-width="1"/>
      <text x="210" y="388" class="seal-text${sealSize}">${escapeXml(input.sealLabel)}</text>
    </g>
  </g>`;
}

function renderEnded(
  input: ActivityImagePresentation & {
    title: string;
    sender: string;
    state: ActivityImageRenderState;
    scope: string;
  },
) {
  return `<g class="packet ended-packet" filter="url(#${input.scope}-softShadow)">
    <rect x="10" y="8" width="400" height="544" rx="28" fill="#b88c7d"/>
    <path d="${UPPER_COVER}" fill="#c39989"/>
    <path d="${COVER_SEAM}" fill="none" stroke="#a27767" stroke-opacity=".3" stroke-width="1.5"/>
    <text x="210" y="125" class="sender ended-sender">${escapeXml(input.sender)}</text>
    ${renderTitleLines(input.title, { className: "title-line ended-title", startY: 190 })}
    <g class="ended-stamp">
      <rect x="105" y="353" width="210" height="64" rx="12" fill="#e2cba7"/>
      <text x="210" y="385" class="ended-stamp-text">${escapeXml(input.sealLabel)}</text>
    </g>
  </g>`;
}

function renderClaimed(
  input: ActivityImagePresentation & {
    title: string;
    sender: string;
    timeZone: string;
    animated: boolean;
    scope: string;
  },
) {
  const amount = clampText(displayAmountText(input.amount), 18);
  const units = Array.from(amount).reduce(
    (sum, char) => sum + (/[\u0020-\u007e]/.test(char) ? 0.65 : 1),
    0,
  );
  const amountSize = Math.min(48, 306 / Math.max(1, units)).toFixed(2);
  const claimedAt = safeDate(input.claimedAt, null);
  const claimTime = claimedAt
    ? `领取于 ${snapshotDisplay(claimedAt, input.timeZone, true)}`
    : "领取时间未记录";
  return `${input.animated ? renderClaimedStyles(input.scope) : ""}
  <g class="packet claimed-packet" filter="url(#${input.scope}-softShadow)">
    <g clip-path="url(#${input.scope}-packetClip)">
      <rect class="claimed-background" x="10" y="8" width="400" height="544" rx="28" fill="#f6efdf"/>
      <g class="claimed-result">
        <text x="210" y="260" class="prize" style="font-size:${amountSize}px">${escapeXml(amount)}</text>
        <text x="210" y="303" class="claimed-status">${escapeXml(input.statusText ?? "已领取")}</text>
        <text x="210" y="524" class="claimed-time"${claimedAt ? ` data-claimed-at="${claimedAt.toISOString()}"` : ""}>${escapeXml(claimTime)}</text>
      </g>
      <g class="open-upper" transform="translate(0 -196)"><path d="${UPPER_COVER}" fill="#d65b43"/><path d="${COVER_SEAM}" fill="none" stroke="#a83f30" stroke-opacity=".35" stroke-width="1.5"/></g>
      ${
        input.animated
          ? `<g class="open-lower" aria-hidden="true"><path d="${LOWER_COVER}" fill="#c94b37"/><circle cx="210" cy="388" r="58" fill="#dfbd7c" stroke="#8b6435" stroke-opacity=".24" stroke-width="1"/><text x="210" y="388" class="seal-text">开</text></g>`
          : ""
      }
      ${renderClaimedHeader(input.title, input.sender, input.animated)}
    </g>
  </g>`;
}

function renderTitleLines(
  title: string,
  options: { className?: string; startY?: number; lineHeight?: number } = {},
) {
  const lines = splitTitle(title);
  const {
    className = "title-line",
    startY = lines.length === 1 ? 200 : 180,
    lineHeight = 38,
  } = options;
  return lines
    .map(
      (line, index) =>
        `<text x="210" y="${startY + index * lineHeight}" class="${className}">${escapeXml(line)}</text>`,
    )
    .join("\n    ");
}

function renderClaimedHeader(title: string, sender: string, animated: boolean) {
  const lines = splitTitle(title);
  const item = (
    text: string,
    className: string,
    sourceY: number,
    finalY: number,
  ) =>
    `<g class="claimed-header-item" transform="translate(210 ${finalY}) scale(.7)"${
      animated ? ` style="--source-y:${sourceY}px;--final-y:${finalY}px"` : ""
    }><text x="0" y="0" class="${className}">${escapeXml(text)}</text></g>`;
  return `${item(sender, "sender claimed-sender", 125, 70)}
      ${lines
        .map((line, index) =>
          item(
            line,
            "title-line claimed-title",
            lines.length === 1 ? 200 : 180 + index * 38,
            lines.length === 1 ? 120 : 105 + index * 24,
          ),
        )
        .join("\n      ")}`;
}

function renderActiveStyles(
  scope: string,
  ageSeconds: number,
  animated: boolean,
) {
  const root = scopedRoot(scope);
  const entrance = animated
    ? `
    ${root} .packet, ${root} .sender, ${root} .title-line, ${root} .seal, ${root} .data-row, ${root} .snapshot-time { opacity: 0; animation: ${scope}-fade-in 720ms ease-out forwards; }
    ${root} .sender, ${root} .title-line { animation-delay: 120ms; }
    ${root} .seal { animation-delay: 260ms; }
    ${root} .data-row, ${root} .snapshot-time { animation-delay: 360ms; }
    ${root} .gold-particle { opacity: 0; animation: ${scope}-gold-dust 2100ms ease-out forwards; }
    @keyframes ${scope}-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ${scope}-gold-dust { 0% { opacity: 0; } 18% { opacity: .95; } 100% { opacity: 0; } }`
    : "";
  const aging =
    ageSeconds < 60
      ? `animation-duration:60s;animation-delay:-${ageSeconds}s;animation-timing-function:linear;animation-fill-mode:both;animation-iteration-count:1;`
      : "animation:none;";
  const warning =
    ageSeconds >= 30
      ? "opacity:0;"
      : ageSeconds >= 10
        ? `opacity:1;animation:${scope}-warning ${30 - ageSeconds}s steps(1,end) 0s forwards;`
        : `opacity:0;animation:${scope}-warning 20s steps(1,end) ${10 - ageSeconds}s forwards;`;
  const stale =
    ageSeconds >= 30
      ? "opacity:1;"
      : `opacity:0;animation:${scope}-stale 1ms step-end ${30 - ageSeconds}s forwards;`;
  return `<style>
    ${entrance}
    ${root} .aging-layer{${aging}}
    ${root} .patina-wash{opacity:.5;${ageSeconds < 60 ? `animation-name:${scope}-patina;` : ""}}
    ${root} .edge-wear{opacity:.55;${ageSeconds < 60 ? `animation-name:${scope}-edge;` : ""}}
    ${root} .surface-wear{opacity:.44;${ageSeconds < 60 ? `animation-name:${scope}-surface;` : ""}}
    ${root} .seal-wear{opacity:.6;${ageSeconds < 60 ? `animation-name:${scope}-seal-wear;` : ""}}
    ${root} .freshness-warning{${warning}}
    ${root} .stale-prompt{${stale}}
    @keyframes ${scope}-patina{0%,16.666667%{opacity:0}50%{opacity:.3}100%{opacity:.5}}
    @keyframes ${scope}-edge{0%,16.666667%{opacity:0}50%{opacity:.36}100%{opacity:.55}}
    @keyframes ${scope}-surface{0%,16.666667%{opacity:0}50%{opacity:.28}100%{opacity:.44}}
    @keyframes ${scope}-seal-wear{0%,16.666667%{opacity:0}50%{opacity:.4}100%{opacity:.6}}
    @keyframes ${scope}-warning{from{opacity:1}to{opacity:0}}
    @keyframes ${scope}-stale{from{opacity:1}to{opacity:1}}
    @media (prefers-reduced-motion: reduce){${root} .packet,${root} .sender,${root} .title-line,${root} .seal,${root} .data-row,${root} .snapshot-time{animation:none;opacity:1}${root} .gold-particle{animation:none;display:none}}
  </style>`;
}

function renderClaimedStyles(scope: string) {
  const root = scopedRoot(scope);
  return `<style>
    ${root} .open-upper{transform:translateY(-196px);animation:${scope}-upper-open 1200ms cubic-bezier(.2,.75,.2,1) 250ms both}
    ${root} .open-lower{transform:translateY(300px);animation:${scope}-lower-open 1200ms cubic-bezier(.2,.75,.2,1) 250ms both}
    ${root} .claimed-header-item{transform:translate(210px,var(--final-y)) scale(.7);animation:${scope}-header-open 1200ms cubic-bezier(.2,.75,.2,1) 250ms both}
    ${root} .claimed-result{opacity:1;animation:${scope}-prize-reveal 650ms ease-out 1150ms both}
    @keyframes ${scope}-upper-open{from{transform:translateY(0)}to{transform:translateY(-196px)}}
    @keyframes ${scope}-lower-open{from{transform:translateY(0)}to{transform:translateY(300px)}}
    @keyframes ${scope}-header-open{from{transform:translate(210px,var(--source-y)) scale(1)}to{transform:translate(210px,var(--final-y)) scale(.7)}}
    @keyframes ${scope}-prize-reveal{from{opacity:0}to{opacity:1}}
    @media (prefers-reduced-motion: reduce){${root} .open-upper,${root} .open-lower,${root} .claimed-header-item,${root} .claimed-result{animation:none}${root} .open-lower{display:none}}
  </style>`;
}

function renderSharedStyles(scope: string) {
  const root = scopedRoot(scope);
  return `<style>
    ${root} text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;text-anchor:middle;letter-spacing:0}
    ${root} .sender{fill:#f5d6a5;font-size:20px;font-weight:520}
    ${root} .title-line{fill:#f9e2b8;font-size:28px;font-weight:540}
    ${root} .seal-text{fill:#73502b;font-size:46px;font-weight:620}
    ${root} .seal-text-compact{font-size:24px;font-weight:560}
    ${root} .seal-text,${root} .ended-stamp-text{dominant-baseline:central}
    ${root} .data-row{fill:#f4d5a0;font-size:18px;font-weight:520}
    ${root} .snapshot-time{fill:#e8bd84;font-size:13px}
    ${root} .freshness-warning,${root} .stale-prompt{fill:#fae5bf;font-size:14px}
    ${root} .ended-sender,${root} .ended-title{fill:#fff0dc}
    ${root} .ended-stamp-text{fill:#795b46;font-size:30px;font-weight:640}
    ${root} .prize{fill:#168045;font-weight:720}
    ${root} .claimed-status{fill:#7b5b2b;font-size:16px;font-weight:520}
    ${root} .claimed-time{fill:#928678;font-size:13px;font-weight:400}
  </style>`;
}

function scopedRoot(scope: string) {
  return `svg[data-scope="${scope}"]`;
}

function displayAmountText(value: unknown) {
  const text = normalizeText(value, "已分配 LDC");
  if (/^[+-]/.test(text) || text === "已分配 LDC") return text;
  return `+${text}`;
}

function renderAging(scope: string) {
  return `<g clip-path="url(#${scope}-packetClip)" aria-hidden="true">
      <rect class="aging-layer patina-wash" x="-24" y="-24" width="468" height="620" fill="#d0b5a9"/>
      <g class="aging-layer edge-wear" fill="none" stroke="#f4d5b9" stroke-linecap="round"><rect x="11" y="9" width="398" height="542" rx="27" stroke-width="2"/><path d="M24 66v28m3 113v19m367-136v21m-3 189v32M38 533h22m63 5h17m215-5h25M24 470v24m373-43v31" stroke-width="1"/></g>
      <g class="aging-layer surface-wear" fill="none" stroke="#f3d0ad" stroke-width="1.25" stroke-linecap="round"><path d="m47 58 9-2m22 31 6-1m243-25 12-2m32 64 8-1M42 163l7-2m313 48 10-1M64 238l8-1m253-5 7-2M40 287l12-2m316 27 9-1M58 348l7-2m298 30 11-2M40 414l8-1m23 26 12-2m266-8 7-1M75 517l8-2m210 5 13-1m39-22 7-1"/></g>
    </g>`;
}

function renderSealWear(scope: string) {
  return `<g clip-path="url(#${scope}-sealClip)" aria-hidden="true"><g class="aging-layer seal-wear" fill="none" stroke="#f4dfb5" stroke-width="1" stroke-linecap="round"><path transform="translate(0 16)" d="m164 351 10-5m-8 12 5-3m73 57 9-5m-16 10 5-3m-47-82 7-2"/></g></g>`;
}

function renderGoldParticles(animated: boolean) {
  if (!animated) return "";
  const particles = [
    [119, 322, 2, 0],
    [151, 312, 2.5, 80],
    [182, 302, 2, 180],
    [236, 303, 2.5, 280],
    [271, 321, 2, 380],
    [290, 356, 2.5, 480],
    [135, 388, 2, 580],
    [263, 403, 2, 680],
    [198, 312, 1.6, 760],
    [220, 415, 1.8, 840],
  ];
  return `<g class="gold-particles" transform="translate(0 16)" fill="#f7dc9a" aria-hidden="true">${particles
    .map(
      ([x, y, r, delay]) =>
        `<circle cx="${x}" cy="${y}" r="${r}" class="gold-particle" style="animation-delay:${delay}ms"/>`,
    )
    .join("")}</g>`;
}

function quantityDisplay(activity: PublicActivity) {
  const quantity = activity.quantity;
  const draw = Boolean(activity.draw);
  if (quantity.mode === "hidden") return null;
  if (draw) {
    const registered = activity.draw?.registeredCount;
    if (quantity.mode === "exact" && typeof registered === "number")
      return `已报名 ${registered} 人`;
    return "限时开奖";
  }
  if (quantity.mode === "exact") return `剩余 ${quantity.remaining} 份`;
  if (quantity.mode === "availability")
    return quantity.available ? "仍可参与" : "名额已满";
  return (
    {
      plenty: "名额充足",
      limited: "名额有限",
      low: "名额不多",
      empty: "名额已满",
    } satisfies Record<typeof quantity.level, string>
  )[quantity.level];
}

function paymentStatusText(status: ActivityImagePaymentStatus) {
  if (status === "confirmed") return "已发放";
  if (status === "attention") return "需要关注";
  if (status === "reconciling") return "正在核对原订单";
  if (status === "pending" || status === "sending" || status === "waiting")
    return "付款处理中";
  return "付款处理中";
}

function safeGeneratedUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") {
      const match = /^\/e\/([^/]+)(\/live\.svg)?$/.exec(url.pathname);
      if (match?.[1]) {
        const emoji = decodeURIComponent(match[1]);
        // Only decode a validated activity code; URL delimiters stay encoded.
        if (decodeActivityEmoji(emoji))
          return `${url.origin}/e/${emoji}${match[2] ?? ""}${url.search}${url.hash}`;
      }
      return url.toString();
    }
  } catch {
    // fall through
  }
  throw new TypeError("Invalid generated activity image URL");
}

function statusForActive(state: ActivityImageRenderState) {
  if (state === "registered") return "已报名，等待开奖";
  if (state === "drawing") return "开奖中";
  if (state === "loading") return "读取中";
  if (state === "pending") return "处理中";
  return null;
}

function dataAttributes(date: Date, timeZone: string) {
  return ` data-updated-at="${date.toISOString()}" data-expires-at="${new Date(
    date.getTime() + 30_000,
  ).toISOString()}" data-timezone="${escapeXml(timeZone)}"`;
}

function snapshotDisplay(date: Date, timeZone: string, includeDate = false) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    ...(includeDate
      ? { year: "numeric", month: "2-digit", day: "2-digit" }
      : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const zoneLabel =
    timeZone === "Asia/Shanghai"
      ? "北京时间"
      : String(parts.timeZoneName ?? "").replace("GMT", "UTC");
  const prefix = includeDate
    ? `${parts.year}-${parts.month}-${parts.day} `
    : "";
  return `${prefix}${parts.hour}:${parts.minute}:${parts.second} · ${zoneLabel}`;
}

function splitTitle(value: string) {
  const text = clampText(normalizeText(value, "未命名活动"), 22);
  const codePoints = Array.from(text);
  if (codePoints.length <= 11) return [text];
  const firstLine = codePoints.slice(0, 11).join("");
  const punctuationBreak = Math.max(
    firstLine.lastIndexOf("，"),
    firstLine.lastIndexOf(","),
    firstLine.lastIndexOf("、"),
    firstLine.lastIndexOf(" "),
  );
  const breakIndex =
    punctuationBreak >= 5 && codePoints.length - punctuationBreak - 1 <= 11
      ? punctuationBreak + 1
      : 11;
  return [
    codePoints.slice(0, breakIndex).join(""),
    codePoints.slice(breakIndex).join(""),
  ].filter(Boolean);
}

function normalizeText(value: unknown, fallback: string) {
  const text = stripInvalidXmlChars(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function clampText(value: string, maxLength: number) {
  const codePoints = Array.from(value);
  return codePoints.length > maxLength
    ? `${codePoints.slice(0, maxLength - 1).join("")}…`
    : value;
}

function escapeXml(value: unknown) {
  return stripInvalidXmlChars(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripInvalidXmlChars(value: string) {
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ) {
      output += char;
    }
  }
  return output;
}

function safeDate(value: unknown, fallback: Date | null): Date | null {
  if (value === null || value === undefined) return fallback;
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function scopeId(value: string) {
  const compact = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
  return `rp-${compact || "image"}`;
}
