import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useIdentity } from "../../lib/session";
import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { Page, PageHeader } from "../page/page";

/** /new 发红包: four steps, one card open at a time. */
export function NewView() {
  const { user, csrfToken } = useIdentity();
  // 用它发红包 (docs/judge-square-design.md §6): read as the page opens.
  const asked = useSearch({
    strict: false,
    select: (search) => (search as { judge?: string }).judge,
  });
  const [startJudge] = useState(asked);
  if (!user || !csrfToken) return null;
  return (
    <Page>
      <PageHeader title="发红包" />
      <HongbaoForm user={user} csrfToken={csrfToken} startJudge={startJudge} />
    </Page>
  );
}
