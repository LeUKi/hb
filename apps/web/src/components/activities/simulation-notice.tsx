export function SimulationNotice() {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
      本地模拟 LDC，不进行真实付款。商户配置请使用虚拟 client_id
      和密钥；模拟适配器不读取密钥，不调用 LDC 外部接口。
    </p>
  );
}
