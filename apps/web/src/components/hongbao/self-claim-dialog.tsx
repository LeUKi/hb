import { useAtomValue } from "jotai";
import { useRef } from "react";
import { selfClaimAtom } from "../../lib/self-claim";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/**
 * 自领 (docs/self-claim-design.md): before the sender takes a share of
 * their own 红包, once, however it was asked for (the seal, the box, a
 * 口令 from the start page). 返回 sends nothing.
 */
export function SelfClaimDialog() {
  const request = useAtomValue(selfClaimAtom);
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(request);
  if (request) last.current = request;
  const draw = (request ?? last.current)?.draw === true;
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(false)}
      title={draw ? "报名自己的红包" : "领自己的红包"}
      text={
        draw
          ? "会占掉一个名额；中了的话，名单里显示「自领的屑」。"
          : "会占掉一份，名单里显示「自领的屑」。"
      }
      actions={
        <>
          <Button onClick={() => request?.resolve(false)}>返回</Button>
          <Button variant="primary" onClick={() => request?.resolve(true)}>
            {draw ? "报名" : "领取"}
          </Button>
        </>
      }
    />
  );
}
