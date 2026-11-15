import { setThemePref, type ThemePref, useTheme } from "../../lib/theme";
import { Segmented } from "../ui/segmented";

/** 外观 in the account card: 跟随系统, 浅色 or 深色 (lib/theme.ts). */
export function ThemeSwitch() {
  const { choice } = useTheme();
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1">
      <span className="text-sm text-ink-2">外观</span>
      <Segmented<ThemePref>
        size="sm"
        label="外观"
        value={choice}
        onChange={setThemePref}
        options={[
          { value: "system", label: "跟随系统" },
          { value: "light", label: "浅色" },
          { value: "dark", label: "深色" },
        ]}
      />
    </div>
  );
}
