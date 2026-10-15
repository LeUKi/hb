import { useIdentity } from "../../lib/session";
import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { Page, PageHeader } from "../page/page";

/** /new 发红包: four steps, one card open at a time. */
export function NewView() {
  const { user, csrfToken } = useIdentity();
  if (!user || !csrfToken) return null;
  return (
    <Page>
      <PageHeader title="发红包" />
      <HongbaoForm user={user} csrfToken={csrfToken} />
    </Page>
  );
}
