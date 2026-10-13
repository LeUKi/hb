import {
  type ActivityImagePresentation,
  isImageTimeZone,
  renderActivityImage,
} from "@hb/contracts";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ActionButton,
  useActionFeedback,
} from "../../src/components/ui/action-feedback";
import {
  SVG_GALLERY_LOADED_AT,
  type SvgGalleryCategory,
  svgGalleryCategories,
  svgGalleryCategoryLabels,
  svgGalleryFixtures,
} from "./svg-gallery-fixtures";
import "./svg-gallery.css";

type CategoryFilter = SvgGalleryCategory | "all";

const timeZoneOptions = [
  { value: "Asia/Shanghai", label: "北京" },
  { value: "UTC", label: "UTC" },
  {
    value: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    label: "本机",
  },
];

function dedupeTimeZones() {
  const seen = new Set<string>();
  return timeZoneOptions.filter((option) => {
    if (!isImageTimeZone(option.value) || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function systemPrefersReducedMotion() {
  if (typeof window === "undefined" || !("matchMedia" in window)) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function projectionForRender(
  input: ActivityImagePresentation,
  options: {
    fixtureId: string;
    timeZone: string;
    reducedMotion: boolean;
    replay: number | string;
    lockSnapshotAge?: boolean;
  },
): ActivityImagePresentation {
  return {
    ...input,
    timeZone: options.timeZone,
    animated:
      !options.lockSnapshotAge &&
      !options.reducedMotion &&
      input.animated !== false,
    instanceId: `svg-gallery-${options.fixtureId}-${options.replay}`,
    now: options.lockSnapshotAge ? SVG_GALLERY_LOADED_AT : input.now,
  };
}

function SvgPreview({
  sampleId,
  projection,
  freezeSnapshot,
}: {
  sampleId: string;
  projection: ActivityImagePresentation;
  freezeSnapshot?: boolean;
}) {
  const svg = useMemo(() => renderActivityImage(projection), [projection]);
  return (
    <div
      className={`svg-gallery-preview${freezeSnapshot ? " svg-gallery-preview--snapshot" : ""}`}
      data-preview-id={sampleId}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shared SVG renderer escapes all sample text and attributes.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function canReplayFixture(
  projection: ActivityImagePresentation,
  lockSnapshotAge?: boolean,
) {
  if (lockSnapshotAge || projection.animated === false) return false;
  if (
    projection.state === "neutral" ||
    projection.state === "ended" ||
    projection.state === "not_won" ||
    projection.state === "error" ||
    projection.state === "unavailable"
  )
    return false;
  return !(projection.state === "claimed" && projection.revealPhase === "open");
}

function SvgGalleryCard({
  fixture,
  globalReplay,
  timeZone,
  reducedMotion,
}: {
  fixture: (typeof svgGalleryFixtures)[number];
  globalReplay: number;
  timeZone: string;
  reducedMotion: boolean;
}) {
  const [localReplay, setLocalReplay] = useState(0);
  const replayFeedback = useActionFeedback(`svg-gallery:replay:${fixture.id}`);
  const replayable = canReplayFixture(
    fixture.projection,
    fixture.lockSnapshotAge,
  );
  const projection = projectionForRender(fixture.projection, {
    fixtureId: fixture.id,
    timeZone,
    reducedMotion,
    replay: `${globalReplay}-${localReplay}`,
    lockSnapshotAge: fixture.lockSnapshotAge,
  });

  function replayCard() {
    if (reducedMotion || !replayable) return;
    setLocalReplay((value) => value + 1);
    replayFeedback.show("已重播", "已重新挂载这个 SVG 示例");
  }

  return (
    <article className="svg-gallery-card" data-sample-id={fixture.id}>
      <header className="svg-gallery-card-head">
        <div>
          <h2>{fixture.label}</h2>
          <p>{fixture.description}</p>
        </div>
        <span className="svg-gallery-card-category">
          {svgGalleryCategoryLabels[fixture.category]}
        </span>
      </header>
      <SvgPreview
        sampleId={fixture.id}
        projection={projection}
        freezeSnapshot={fixture.lockSnapshotAge}
      />
      {replayable && (
        <div className="svg-gallery-card-actions">
          <ActionButton
            className="button svg-gallery-card-replay"
            type="button"
            label="重播"
            aria-label={`${fixture.label}，重播动画`}
            reserve={["已重播"]}
            feedback={replayFeedback.feedback}
            icon={<RefreshCw size={14} aria-hidden="true" />}
            disabled={reducedMotion}
            onClick={replayCard}
          />
        </div>
      )}
    </article>
  );
}

export function SvgGallery() {
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [timeZone, setTimeZone] = useState(
    dedupeTimeZones()[0]?.value ?? "Asia/Shanghai",
  );
  const [reducedMotion, setReducedMotion] = useState(
    systemPrefersReducedMotion,
  );
  const [replay, setReplay] = useState(0);
  const replayFeedback = useActionFeedback("svg-gallery:replay:all");
  const timeZones = useMemo(dedupeTimeZones, []);
  const filtered = useMemo(
    () =>
      category === "all"
        ? svgGalleryFixtures
        : svgGalleryFixtures.filter((fixture) => fixture.category === category),
    [category],
  );

  function replayAll() {
    if (reducedMotion) return;
    setReplay((value) => value + 1);
    replayFeedback.show("已重播", "已重新挂载当前筛选下的 SVG 示例");
  }

  return (
    <section className="svg-gallery-page" aria-labelledby="svg-gallery-title">
      <header className="svg-gallery-heading">
        <div>
          <h1 id="svg-gallery-title">SVG 红包总览</h1>
          <p>本地示例 · 与正式活动图片共用渲染器</p>
        </div>
        <ActionButton
          className="button svg-gallery-replay"
          type="button"
          label="重播动画"
          reserve={["已重播"]}
          feedback={replayFeedback.feedback}
          icon={<RefreshCw size={16} aria-hidden="true" />}
          disabled={reducedMotion}
          onClick={replayAll}
        />
      </header>

      <section className="svg-gallery-controls" aria-label="SVG 示例控制">
        <div className="field">
          <label
            className="svg-gallery-control-label"
            htmlFor="svg-gallery-category"
          >
            样例分类
          </label>
          <select
            id="svg-gallery-category"
            name="样例分类"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as CategoryFilter)
            }
          >
            <option value="all">
              {svgGalleryCategoryLabels.all}（{svgGalleryFixtures.length}）
            </option>
            {svgGalleryCategories.map((value) => (
              <option key={value} value={value}>
                {svgGalleryCategoryLabels[value]}（
                {
                  svgGalleryFixtures.filter(
                    (fixture) => fixture.category === value,
                  ).length
                }
                ）
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label
            className="svg-gallery-control-label"
            htmlFor="svg-gallery-timezone"
          >
            时区
          </label>
          <select
            id="svg-gallery-timezone"
            value={timeZone}
            onChange={(event) => {
              const value = event.target.value;
              if (isImageTimeZone(value)) setTimeZone(value);
            }}
          >
            {timeZones.map((option) => (
              <option
                key={`${option.label}:${option.value}`}
                value={option.value}
              >
                {option.label} · {option.value}
              </option>
            ))}
          </select>
        </div>

        <label className="svg-gallery-check">
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(event) => setReducedMotion(event.target.checked)}
          />
          <span className="svg-gallery-control-label">减少动态效果</span>
        </label>

        <span className="svg-gallery-count" aria-live="polite">
          当前 {filtered.length} 个示例
        </span>
      </section>

      <section className="svg-gallery-grid" aria-label="SVG 红包示例">
        {filtered.map((fixture) => (
          <SvgGalleryCard
            key={`${fixture.id}:${replay}`}
            fixture={fixture}
            globalReplay={replay}
            timeZone={timeZone}
            reducedMotion={reducedMotion}
          />
        ))}
      </section>
    </section>
  );
}
