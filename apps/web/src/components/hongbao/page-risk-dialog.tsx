import { useAtomValue } from "jotai";
import { useRef } from "react";
import { pageRiskAtom } from "../../lib/page-risk";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/** The 站长's LINUX DO username: whom to tell about a page that breaks the rules. */
const OWNER = "lafish";

/**
 * 打开附带网页？ (docs/attached-page-design.md §2.5): before a site's page
 * first loads in this browser. 取消 loads nothing.
 */
export function PageRiskDialog() {
  const request = useAtomValue(pageRiskAtom);
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(false)}
      title="打开附带网页？"
      text={
        <>
          {shown?.site} 不是红包站的网页
          {shown?.author ? `，是 @${shown.author} 附带的` : ""}
          。它能看到你的 IP
          和浏览器信息。不要在里面付款、转账或做任何交易；发现违规推广，请联系站长{" "}
          <a
            href={`https://linux.do/u/${OWNER}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent-ink underline underline-offset-2"
          >
            @{OWNER}
          </a>
          。
        </>
      }
      actions={
        <>
          <Button onClick={() => request?.resolve(false)}>取消</Button>
          <Button variant="primary" onClick={() => request?.resolve(true)}>
            打开
          </Button>
        </>
      }
    >
      <p className="text-xs text-ink-3">确认后，这个网站下次直接打开。</p>
    </ConfirmDialog>
  );
}
