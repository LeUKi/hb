export function PasswordField({
  value,
  onChange,
  disabled = false,
  dedicatedStatistics = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  dedicatedStatistics?: boolean;
}) {
  return (
    <>
      <label className="activity-label" htmlFor="claim-password">
        兑换口令
        <input
          id="claim-password"
          className="activity-input"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="text-xs text-neutral-500">
        6–18
        个字符，仅限汉字、英文字母和数字，区分大小写。每个账号在同一活动最多领取一份。
      </p>
      {dedicatedStatistics ? (
        <p className="text-sm text-neutral-600">
          提交的口令将供活动作者查看，用于兑换尝试统计。
        </p>
      ) : null}
    </>
  );
}
