import { PasswordInput } from "../presentation/password-input";
export function PasswordField({
  value,
  onChange,
  disabled = false,
  dedicatedStatistics = false,
  onSubmit,
  label = "兑换口令",
  placeholder,
  mode,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  dedicatedStatistics?: boolean;
  onSubmit?: () => void;
  label?: string;
  placeholder?: string;
  mode?: "password" | "locator";
}) {
  return (
    <>
      <PasswordInput
        value={value}
        onChange={onChange}
        disabled={disabled}
        id="claim-password"
        label={label}
        placeholder={placeholder}
        mode={mode}
        sharedFrame
        onSubmit={onSubmit}
      />
      {dedicatedStatistics && (
        <p className="text-xs text-subtle">
          提交的口令将供活动作者查看，用于兑换尝试统计。
        </p>
      )}
    </>
  );
}
