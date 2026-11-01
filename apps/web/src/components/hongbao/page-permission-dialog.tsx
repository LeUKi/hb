import { useAtomValue } from "jotai";
import { useRef } from "react";
import { pagePermissionAtom } from "../../lib/page-submit";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/**
 * 网页的许可 (docs/page-identity-design.md §3): before a 附带网页 first
 * learns who the viewer is or, on a 代码判定红包, submits for them; once
 * per 红包 and site, for both. 不允许 gives it neither.
 */
export function PagePermissionDialog() {
  const request = useAtomValue(pagePermissionAtom);
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const site = shown?.site ?? "";
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(false)}
      title={
        shown?.code
          ? "让这个网页知道你是谁、替你提交？"
          : "让这个网页知道你是谁？"
      }
      text={
        shown?.code
          ? `${site} 会知道你的用户名和 ID，并能替你提交输入；提交的内容和结果会出现在你的「我的记录」里，冷却和人机验证照旧。只对这个红包有效。`
          : `${site} 会知道你的用户名和 ID。只对这个红包有效。`
      }
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
