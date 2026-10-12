export type Page =
  | "home"
  | "activity"
  | "square"
  | "participations"
  | "create"
  | "manage"
  | "account"
  | "merchant"
  | "payment"
  | "statistics"
  | "admin";
export type Identity = "standard" | "lite" | "guest";
export type Scenario =
  | "ready"
  | "random"
  | "random-ended"
  | "text"
  | "pending"
  | "registered"
  | "drawing"
  | "notes-drawing-ended"
  | "won"
  | "not-won"
  | "draw-empty"
  | "draw-no-winners"
  | "ended"
  | "long"
  | "multiple"
  | "slow"
  | "failure";
export type Participation =
  | "none"
  | "registered"
  | "drawing"
  | "won"
  | "not-won"
  | "claimed";
export type ActivityLifecycle = "draft" | "active" | "ended" | "archived";
export type DrawProgress = "waiting" | "settling" | "completed" | "empty";
export type PaymentProgress =
  | "pending"
  | "sending"
  | "reconciling"
  | "waiting"
  | "confirmed"
  | "attention";
export type ActivityViewState = {
  lifecycle: ActivityLifecycle;
  participation: Participation;
  drawProgress: DrawProgress | null;
  paymentProgress: PaymentProgress | null;
};
export type ActivityViewStateOverrides = Partial<ActivityViewState>;
export type RewardMode = "fixed" | "instant_random" | "custom" | "timed_draw";
export type ParticipationResult = {
  participation: Exclude<Participation, "none">;
  participatedAt: string;
  /** Time this local sample confirmed upstream delivery, never an arrival time. */
  confirmedAt?: string | null;
  rewardAmount?: string;
  rewardText?: string;
  password?: string;
  viewState: ActivityViewStateOverrides;
};
export type Activity = {
  id: string;
  title: string;
  author: string;
  username: string;
  color: string;
  type: "ldc" | "text" | "draw";
  description: string;
  topicUrl?: string;
  /** Local configuration source; authorize phase notes before rendering. */
  beforeInfo?: string;
  afterClaimInfo?: string;
  afterEndInfo?: string;
  amount: string;
  rewardMode?: RewardMode;
  poolAmount?: string;
  publishedRecipientAmounts?: string[];
  registrationCount?: number;
  deadlineAt?: string | null;
  count: number;
  remaining: number;
  passwords: string[];
  ended?: boolean;
  lifecycle?: ActivityLifecycle;
  drawProgress?: DrawProgress;
};
export type Nav = (page: Page) => void;
export type PageProps = {
  navigate: Nav;
  identity: Identity;
  onIdentityChange?: (identity: Identity) => void;
};
