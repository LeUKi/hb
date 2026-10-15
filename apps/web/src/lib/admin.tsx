import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminAuditEntry,
  AdminCursorList,
  AdminOverview,
  AdminPaymentDetail,
  AdminPaymentListItem,
  AdminUserDetail,
  AdminUserListItem,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { ActivityErrorView } from "../components/activities/activity-error";
import { RequireAccount } from "../components/activities/require-account";
import {
  ActionButton,
  useActionFeedback,
} from "../components/ui/action-feedback";
import { ActivityRequestError, readResponse } from "./activities";
import { adminIdentity } from "./admin-identity";
import { type SessionResponse, sessionQueryKey, useSession } from "./auth";

export const adminSections = [
  { to: "/admin", label: "概览" },
  { to: "/admin/activities", label: "活动" },
  { to: "/admin/users", label: "用户" },
  { to: "/admin/payments", label: "付款" },
  { to: "/admin/settings", label: "网站设置" },
  { to: "/admin/audit", label: "操作记录" },
] as const;

export function AdminGuard({
  children,
}: {
  children: (input: {
    userId: string;
    csrfToken: string;
    identity: string;
  }) => ReactNode;
}) {
  const session = useSession();
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => {
        if (!session.data?.user?.isAdmin)
          return (
            <section className="work-page">
              <h1>网站管理</h1>
              <p role="alert">此页面仅限管理员访问</p>
            </section>
          );
        const identity = adminIdentity(session.data);
        return (
          <AdminPrivateScope identity={identity}>
            {children({
              userId,
              csrfToken,
              identity,
            })}
          </AdminPrivateScope>
        );
      }}
    </RequireAccount>
  );
}

function AdminPrivateScope({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const previousIdentity = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousIdentity.current;
    previousIdentity.current = identity;
    if (!previous || previous === identity) return;
    void queryClient
      .cancelQueries({ queryKey: ["admin-private", previous] })
      .then(() =>
        queryClient.removeQueries({ queryKey: ["admin-private", previous] }),
      );
  }, [identity, queryClient]);
  return <Fragment key={identity}>{children}</Fragment>;
}

export function AdminDetailSurface({
  open,
  label,
  children,
  placeholder,
  onClose,
}: {
  open: boolean;
  label: string;
  children: ReactNode;
  placeholder: ReactNode;
  onClose: () => void;
}) {
  const [mobile, setMobile] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (mobile && open && !dialog.open) dialog.showModal();
    if ((!mobile || !open) && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [mobile, open]);
  useEffect(() => {
    if (!open || mobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobile, onClose, open]);
  if (mobile)
    return (
      <dialog
        ref={dialogRef}
        className="activity-panel admin-detail-panel admin-detail-dialog"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.defaultPrevented) return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], [tabindex="0"]',
            ),
          ).filter(
            (node) => node.offsetParent !== null && !node.closest("[inert]"),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {open ? (
          <>
            <div className="admin-detail-heading">
              <span className="sr-only">{label}</span>
              <button
                className="button secondary"
                type="button"
                onClick={onClose}
              >
                关闭
              </button>
            </div>
            {children}
          </>
        ) : null}
      </dialog>
    );
  return (
    <aside
      role={open ? "dialog" : undefined}
      className="activity-panel admin-detail-panel"
      aria-label={label}
    >
      {open ? (
        <>
          <div className="admin-detail-heading">
            <span className="sr-only">{label}</span>
            <button
              className="button secondary"
              type="button"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
          {children}
        </>
      ) : (
        placeholder
      )}
    </aside>
  );
}

export function AdminShell({
  active,
  children,
}: {
  active: (typeof adminSections)[number]["to"];
  children: ReactNode;
}) {
  return (
    <section className="work-page admin-page">
      <div className="work-page-heading">
        <div>
          <h1>网站管理</h1>
        </div>
      </div>
      <nav className="admin-tabs" aria-label="管理入口">
        {adminSections.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="admin-tab"
            aria-current={active === item.to ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </section>
  );
}

export function useCurrentAdmin(identity: string) {
  const queryClient = useQueryClient();
  return () => {
    if (queryClient.getQueryState(sessionQueryKey)?.status !== "success")
      return false;
    const session = queryClient.getQueryData<SessionResponse>(sessionQueryKey);
    return Boolean(
      session?.user?.isAdmin && adminIdentity(session) === identity,
    );
  };
}

export function clearAdminPrivateOnAccessDenied(
  queryClient: ReturnType<typeof useQueryClient>,
  error: unknown,
) {
  if (
    !(error instanceof ActivityRequestError) ||
    ![401, 403].includes(error.status)
  )
    return false;
  queryClient.setQueryData<SessionResponse>(sessionQueryKey, (previous) => {
    if (!previous) return previous;
    if (error.status === 401)
      return { user: null, csrfToken: null, attemptCooldown: null };
    if (!previous.user) return previous;
    return {
      ...previous,
      user: { ...previous.user, isAdmin: false },
    };
  });
  void queryClient.cancelQueries({ queryKey: ["admin-private"] });
  queryClient.removeQueries({ queryKey: ["admin-private"] });
  void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
  return true;
}

export function adminKey(identity: string, ...parts: unknown[]) {
  return ["admin-private", identity, ...parts] as const;
}

export function fmtTime(value: number | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "无";
}

export function boolText(value: boolean) {
  return value ? "开启" : "关闭";
}

function readErrorDetail(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type AdminRefreshResult = { isError?: boolean; error?: unknown } | undefined;

export function AdminRefreshButton({
  scope,
  label = "刷新",
  busy,
  onRefresh,
  failureDetail = "读取失败，请重试。",
  reserve = ["已刷新", "刷新失败"],
  icon = <RefreshCw size={16} aria-hidden="true" />,
  disabled,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> & {
  scope: string | null;
  label?: string;
  busy?: boolean;
  onRefresh: () => AdminRefreshResult | Promise<AdminRefreshResult>;
  failureDetail?: string;
  reserve?: readonly string[];
  icon?: ReactNode;
}) {
  const refreshFeedback = useActionFeedback(scope);
  async function refresh() {
    refreshFeedback.clear();
    try {
      const result = await onRefresh();
      if (result && typeof result === "object" && result.isError) {
        refreshFeedback.show(
          "刷新失败",
          readErrorDetail(result.error, failureDetail),
        );
        return;
      }
      refreshFeedback.show("已刷新");
    } catch (error) {
      refreshFeedback.show("刷新失败", readErrorDetail(error, failureDetail));
    }
  }
  return (
    <ActionButton
      {...props}
      label={label}
      feedback={refreshFeedback.feedback}
      reserve={reserve}
      icon={icon}
      title={props.title ?? label}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={() => void refresh()}
    />
  );
}

export function AdminQueryError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <ActivityErrorView
      error={error instanceof Error ? error : new Error("读取失败，请重试。")}
      retry={retry}
    />
  );
}

export async function fetchAdminOverview(signal?: AbortSignal) {
  return readResponse<AdminOverview>(
    await api.api.admin.overview.$get(undefined, { init: { signal } }),
  );
}

export async function fetchAdminActivities(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
) {
  return readResponse<AdminCursorList<AdminActivityListItem>>(
    await api.api.admin.activities.$get(
      { query: params },
      { init: { signal } },
    ),
  );
}

export async function fetchAdminActivity(id: string, signal?: AbortSignal) {
  return readResponse<{ activity: AdminActivityDetail }>(
    await api.api.admin.activities[":id"].$get(
      { param: { id } },
      { init: { signal } },
    ),
  );
}

export async function fetchAdminUsers(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
) {
  return readResponse<AdminCursorList<AdminUserListItem>>(
    await api.api.admin.users.$get({ query: params }, { init: { signal } }),
  );
}

export async function fetchAdminUser(id: string, signal?: AbortSignal) {
  return readResponse<{ user: AdminUserDetail }>(
    await api.api.admin.users[":id"].$get(
      { param: { id } },
      { init: { signal } },
    ),
  );
}

export async function fetchAdminPayments(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
) {
  return readResponse<AdminCursorList<AdminPaymentListItem>>(
    await api.api.admin.payments.$get({ query: params }, { init: { signal } }),
  );
}

export async function fetchAdminPayment(
  id: string,
  attemptsCursor?: string,
  signal?: AbortSignal,
) {
  return readResponse<{ payment: AdminPaymentDetail }>(
    await api.api.admin.payments[":id"].$get(
      { param: { id }, query: { attemptsCursor } },
      { init: { signal } },
    ),
  );
}

export async function fetchAdminAudit(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
) {
  return readResponse<AdminCursorList<AdminAuditEntry>>(
    await api.api.admin.audit.$get({ query: params }, { init: { signal } }),
  );
}
