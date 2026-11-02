import { Braces, RotateCcw } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import {
  CountUp,
  Seal,
  type SealState,
  Sparks,
} from "../../web/src/components/hongbao/parts";
import { Avatar } from "../../web/src/components/ui/avatar";
import { Button } from "../../web/src/components/ui/button";
import { TextInput } from "../../web/src/components/ui/field";
import {
  MorphLabel,
  RollingText,
} from "../../web/src/components/ui/morph-label";
import { Segmented } from "../../web/src/components/ui/segmented";
import { radius, Squircle } from "../../web/src/components/ui/squircle";
import { cn } from "../../web/src/lib/cn";
import { type Sample, type SampleKind, samples } from "./samples";

// 验证包 (docs/mini-app-design.md §5): one 红包 screen drawn with the
// site's own tokens and parts, to see them run inside the forum's frame —
// the cover, the seal, the open with its sweep and sparks, the result —
// in light and dark. Sample data only.

/** “01:59:41”, by the second. */
function useCountdown(to: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((to - now) / 1000));
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(Math.floor(left / 3600))}:${two(Math.floor(left / 60) % 60)}:${two(left % 60)}`;
}

function Chip({ text }: { text: string }) {
  const code = text === "代码判定";
  return (
    <Squircle radius={10}>
      <span
        className={cn(
          "hb-chip-red inline-flex h-7 items-center px-2.5 text-xs",
          code && "hb-chip-code gap-1",
        )}
      >
        {code && <Braces className="size-3.5" aria-hidden="true" />}
        {text}
      </span>
    </Squircle>
  );
}

function Cell({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  const unit = / LDC$/.exec(value);
  return (
    <div className="grid min-w-0 content-start justify-items-start gap-1">
      <dt className="hb-data-label w-fit max-w-full truncate">{label}</dt>
      <dd className="hb-data-value w-fit max-w-full truncate">
        {unit ? (
          <>
            <RollingText text={value.slice(0, unit.index)} />
            <span className="hb-data-unit"> LDC</span>
          </>
        ) : (
          <RollingText text={value} />
        )}
      </dd>
      {note && (
        <dd className="hb-data-note flex w-full items-center truncate">
          {note}
        </dd>
      )}
    </div>
  );
}

function Meter({ share }: { share: number }) {
  return (
    <Squircle radius={3}>
      <span className="hb-data-meter block h-1.5 w-full overflow-hidden">
        <span
          className="block h-full"
          style={{ width: `${Math.min(1, share) * 100}%` }}
        />
      </span>
    </Squircle>
  );
}

function Cover({
  sample,
  opened,
  play,
  sealState,
  glyph,
  onPress,
  hintId,
  deadline,
}: {
  sample: Sample;
  opened: boolean;
  /** Opened, and motion is not reduced: the light, the flash, the sparks. */
  play: boolean;
  sealState: SealState;
  glyph: string;
  onPress: () => void;
  hintId: string;
  deadline: number;
}) {
  const left = useCountdown(deadline);
  const shares = sample.shares;
  return (
    <div
      className={cn(
        "hb-cover-frame relative z-10",
        sample.kind === "code" && "hb-code",
      )}
      data-hb-part="hero"
    >
      <div className="hb-cover relative">
        <div className="relative flex flex-col items-center gap-5 px-5 pt-6 pb-[calc(var(--seal)/2+1.5rem)] text-center">
          <p className="flex max-w-full items-center gap-2 text-cream-2">
            <Avatar name={sample.author} size={28} />
            <span className="truncate text-[15px] leading-[1.4]">
              {sample.author} 的红包
            </span>
          </p>
          <h1 className="hb-cover-title max-w-[16em] text-[clamp(1.375rem,6.4cqw,2rem)] leading-[1.3] font-semibold text-balance text-cream">
            {sample.title}
          </h1>
          <div className="flex w-full flex-wrap justify-center gap-2">
            {sample.tags.map((tag) => (
              <Chip key={tag} text={tag} />
            ))}
          </div>
          <div className="hb-cover-note relative flex w-fit max-w-[min(30rem,100%)] flex-col text-[15px] leading-6">
            <Squircle radius={radius.card}>
              <div className="hb-cover-note-card px-3.5 py-2.5 text-left text-pretty">
                {sample.note}
              </div>
            </Squircle>
          </div>
          <dl className="grid w-full max-w-[34rem] grid-cols-[repeat(3,minmax(0,auto))] justify-between gap-x-4 px-1">
            <Cell label="奖池" value={`${sample.pool} LDC`} />
            {shares ? (
              <Cell
                label="已领"
                value={`${shares.taken} / ${shares.total} 份`}
                note={<Meter share={shares.taken / shares.total} />}
              />
            ) : (
              <Cell
                label="奖池还剩"
                value={`${sample.left} LDC`}
                note={
                  <Meter share={Number(sample.left) / Number(sample.pool)} />
                }
              />
            )}
            <Cell label="剩余" value={left} />
          </dl>
        </div>
        <span
          aria-hidden="true"
          className="hb-cover-sweep"
          data-play={play || undefined}
          style={{ "--sweep-delay": "0.18s" } as CSSProperties}
        />
      </div>

      {play && (
        <motion.span
          aria-hidden="true"
          className="hb-ring-flash pointer-events-none absolute top-full left-1/2 size-(--seal) -translate-x-1/2 -translate-y-1/2"
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: [0.9, 2.4], opacity: [0.8, 0] }}
          transition={{ duration: 0.46, delay: 0.14 }}
        />
      )}
      {play && <Sparks delay={0.2} count={36} />}

      <AnimatePresence>
        {!opened && (
          <motion.div
            key="seal"
            className="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
            exit={{
              scale: [1, 1.12, 0.5],
              opacity: [1, 1, 0],
              transition: { duration: 0.36, times: [0, 0.4, 1] },
            }}
          >
            <Seal
              glyph={glyph}
              label="开红包"
              state={sealState}
              onPress={onPress}
              describedBy={hintId}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function HongbaoScreen({
  sample,
  reduced,
  onReplay,
}: {
  sample: Sample;
  reduced: boolean;
  onReplay: () => void;
}) {
  const hintId = useId();
  const [deadline] = useState(() => Date.now() + 2 * 3600_000 - 19_000);
  const [phase, setPhase] = useState<"closed" | "pending" | "open">("closed");
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const open = () => {
    setMessage(null);
    setPhase("pending");
    // What a claim's answer takes on the site; here, a stand-in.
    window.setTimeout(() => setPhase("open"), 900);
  };
  const press = () => {
    if (sample.elsewhere || phase !== "closed") return;
    if (sample.password && typed.trim() !== sample.password) {
      setMessage(typed.trim() ? "口令不对，再试一次。" : "先输入口令。");
      return;
    }
    open();
  };
  // No <form>: the forum's frame may not submit one (no submit event at all),
  // so Enter — not while an input method is composing — and 开 call press().
  const enter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) press();
  };

  const sealState: SealState = sample.elsewhere
    ? "muted"
    : phase === "pending"
      ? "pending"
      : "idle";
  const hint = sample.elsewhere
    ? "在论坛里领不了"
    : phase === "pending"
      ? "正在领取…"
      : sample.password
        ? "输入口令，再点「开」"
        : "点「开」领取";

  return (
    <>
      <Cover
        sample={sample}
        opened={phase === "open"}
        play={phase === "open" && !reduced}
        sealState={sealState}
        glyph="开"
        onPress={press}
        hintId={hintId}
        deadline={deadline}
      />
      <AnimatePresence initial={false} mode="popLayout">
        {phase === "open" ? (
          <motion.div
            key="result"
            className="mx-auto grid w-full max-w-[36rem] justify-items-center gap-3 px-5 pt-12 text-center"
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36, delay: 0.62 }}
            data-hb-part="result"
          >
            <p className="flex items-baseline gap-2 text-success">
              <span className="text-[clamp(2.75rem,12cqw,4.5rem)] leading-none font-semibold tracking-tight">
                <CountUp
                  value={sample.amount}
                  play={!reduced}
                  delay={0.7}
                  prefix="+"
                />
              </span>
              <span className="text-xl font-medium">LDC</span>
            </p>
            <p className="text-sm text-ink-2">
              示例：真的领取时，LDC 会发到你的 Credit 账户。
            </p>
            <Button variant="secondary" size="sm" onClick={onReplay}>
              <RotateCcw aria-hidden="true" />
              再开一次
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="hint"
            className="grid justify-items-center gap-3 px-6 text-center"
            style={{ paddingTop: "calc(var(--seal) / 2 + 0.875rem)" }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            <p id={hintId} className="text-lg text-ink">
              <MorphLabel fit={false}>{hint}</MorphLabel>
            </p>
            {sample.password && phase === "closed" && (
              <div className="flex w-full max-w-[22rem] items-center gap-2">
                <div className="min-w-0 flex-1">
                  <TextInput
                    aria-label="口令"
                    placeholder="口令"
                    value={typed}
                    invalid={Boolean(message)}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      setMessage(null);
                    }}
                    onKeyDown={enter}
                  />
                </div>
                <Button type="button" variant="primary" onClick={press}>
                  开
                </Button>
              </div>
            )}
            {message && <p className="text-sm text-danger">{message}</p>}
            {sample.elsewhere && (
              <Squircle radius={radius.card}>
                <div className="hb-note-card grid w-full max-w-[26rem] gap-1.5 px-4 py-3 text-left">
                  <p className="text-base text-ink">{sample.elsewhere}</p>
                  <p className="text-sm break-all text-ink-2 select-all">
                    https://hb.lafi.sh/🧧/示例
                  </p>
                </div>
              </Squircle>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export function App({
  mode,
  reduced,
}: {
  mode: "light" | "dark";
  reduced: boolean;
}) {
  const [kind, setKind] = useState<SampleKind>("direct");
  const [round, setRound] = useState(0);
  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <div
        className="hb-mini"
        data-mode={mode}
        data-motion={reduced ? "reduce" : undefined}
      >
        <HongbaoScreen
          key={`${kind}-${round}`}
          sample={samples[kind]}
          reduced={reduced}
          onReplay={() => setRound((value) => value + 1)}
        />
        {/* Below, not above: the cover is the top of the page, as on the
            site (its red runs on up when pulled past the top). */}
        <footer className="mt-10 grid justify-items-center gap-2 px-4">
          <p className="text-xs text-ink-3">验证包 · 示例红包，不会真的领取</p>
          <Segmented
            label="示例"
            size="sm"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setRound((value) => value + 1);
            }}
            options={[
              { value: "direct", label: "直接领" },
              { value: "password", label: "口令" },
              { value: "code", label: "代码判定" },
              { value: "human", label: "人机验证" },
            ]}
          />
        </footer>
      </div>
    </MotionConfig>
  );
}
