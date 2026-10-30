import { useAtomValue } from "jotai";
import { useRef } from "react";
import { pageSubmitAtom } from "../../lib/page-submit";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/**
 * 网页替你提交 (docs/judge-page-design.md §11.3): before a 代码判定红包's
 * 附带网页 first submits for the viewer, once per 红包 and site. 不允许
 * sends nothing.
 */
export function PageSubmitDialog() {
  const request = useAtomValue(pageSubmitAtom);
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(request);
  if (request) last.current = request;
  const site = (request ?? last.current)?.site ?? "";
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(false)}
      title="让这个网页替你提交？"
      text={`${site} 会替你提交输入，提交的内容和结果会出现在你的「我的记录」里，冷却和人机验证照旧。只对这个红包有效。`}
      actions={
        <>
          <Button onClick={() => request?.resolve(false)}>不允许</Button>
          <Button variant="primary" onClick={() => request?.resolve(true)}>
            允许
          </Button>
        </>
      }
    />
  );
}
