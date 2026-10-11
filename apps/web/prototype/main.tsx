import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  type ActivityWindowSnapshot,
  bootstrapActivityWindow,
} from "./activity-window";
import { App } from "./app";
import { importClaimRosterSnapshot } from "./claim-rosters";
import { importDrawRostersSnapshot } from "./draw-rosters";
import { importWorkbenchStoresSnapshot } from "./pages/workbench-store";
import "./styles.css";
import "./framework.css";
import "./components/compact-controls.css";

const root = document.getElementById("root");
if (!root) throw new Error("Prototype root is missing");
const reactRoot = createRoot(root);

function restoreActivityWindowSnapshot(snapshot: ActivityWindowSnapshot) {
  importWorkbenchStoresSnapshot(snapshot.stores);
  importClaimRosterSnapshot(snapshot.claims);
  importDrawRostersSnapshot(snapshot.draws);
}

function ActivityWindowError({ retry }: { retry: () => void }) {
  return (
    <div className="activity-window-error" role="alert">
      <h1>本地活动页面加载失败</h1>
      <p>新窗口没有收到原型内存状态，可能是来源页面已关闭或链接已过期。</p>
      <button
        className="button"
        style={{ justifySelf: "start" }}
        type="button"
        onClick={retry}
      >
        重试
      </button>
    </div>
  );
}

function renderApp() {
  reactRoot.render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </StrictMode>,
  );
}

const bootstrap = await bootstrapActivityWindow();
if (bootstrap?.ok) {
  restoreActivityWindowSnapshot(bootstrap.snapshot);
  renderApp();
} else if (bootstrap && !bootstrap.ok) {
  reactRoot.render(<ActivityWindowError retry={bootstrap.retry} />);
} else renderApp();
