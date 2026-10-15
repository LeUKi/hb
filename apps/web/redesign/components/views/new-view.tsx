import { HongbaoForm } from "../hongbao-form/hongbao-form";
import { Page, PageHeader } from "../page/page";

/** /new 发红包: four steps, one card open at a time. */
export function NewView() {
  return (
    <Page>
      <PageHeader title="发红包" />
      <HongbaoForm />
    </Page>
  );
}
