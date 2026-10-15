import { decodeActivityEmoji } from "@/lib/ecoji-v2";
import { anchorSamples, findActivity } from "../fixtures/activities";
import { IMAGE_HEIGHT, IMAGE_WIDTH, renderHongbaoImage } from "./hongbao-image";
import {
  audienceFor,
  type ImageViewer,
  imageInputFor,
  isImageViewer,
} from "./hongbao-image-input";
import { squirclePath } from "./squircle-path";

// Serves /🧧/<code>/🖼️.svg and /🧧/<code>/🖼️ in the prototype's dev server
// (vite.redesign.config.ts). Production picks the viewer by the image cookie;
// the dev server has no session, so it draws the guest image unless
// ?viewer= names another (lib/hongbao-image-input.ts), and ?age= (seconds)
// previews the stale notes.

function notFound() {
  const card = squirclePath(10, 10, IMAGE_WIDTH - 20, IMAGE_HEIGHT - 20, 34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" role="img" aria-label="未找到红包"><path d="${card}" fill="#f6e8e4"/><text x="210" y="280" text-anchor="middle" font-size="16" fill="#745c61" font-family="-apple-system, PingFang SC, Microsoft YaHei, sans-serif">红包不存在，或链接已经失效</text></svg>`;
}

export function hongbaoImageResponse(code: string, search: URLSearchParams) {
  const now = Date.now();
  // Each image as if the samples had just loaded, like a fresh page.
  anchorSamples(now);
  const id = decodeActivityEmoji(code);
  const activity = id ? findActivity(id) : null;
  // A 草稿 has no public image (nor page) yet.
  if (!activity || activity.draft) return { status: 404, svg: notFound() };
  const param = search.get("viewer");
  const viewer: ImageViewer = isImageViewer(param) ? param : "guest";
  const age = Number(search.get("age") ?? 0);
  const sims = { drawSim: "waiting", paymentSim: "auto", now } as const;
  const { audience, drawSim } = audienceFor(activity, viewer, sims);
  const input = imageInputFor(activity, audience, {
    ...sims,
    drawSim,
    age: Number.isFinite(age) && age > 0 ? age : 0,
  });
  return { status: 200, svg: renderHongbaoImage(input) };
}
