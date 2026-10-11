export function SimulationNotice() {
  return (
    <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm leading-6 text-warning">
      本地模拟 LDC，不进行真实付款。商户配置请使用虚拟 client_id
      和密钥；模拟适配器不读取密钥，不调用 LDC 外部接口。
    </p>
  );
}
