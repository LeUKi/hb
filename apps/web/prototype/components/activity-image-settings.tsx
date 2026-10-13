import type { ActivityImagePreferences } from "@hb/contracts";
import { useState } from "react";
import { ImageSettingsView } from "../../src/components/activities/activity-image-settings";

// Prototype preferences belong to the browser demonstration, never the selected account.
let browserPreferences: ActivityImagePreferences = {
  timeZone: "Asia/Shanghai",
  recentRequest: null,
};
export function PrototypeActivityImageSettings() {
  const [data, setData] = useState(browserPreferences);
  return (
    <ImageSettingsView
      data={data}
      onRefresh={async () => setData(browserPreferences)}
      onSave={async (timeZone) => {
        browserPreferences = { ...browserPreferences, timeZone };
        setData(browserPreferences);
      }}
      onClear={async () => {
        browserPreferences = { ...browserPreferences, recentRequest: null };
        setData(browserPreferences);
      }}
    />
  );
}
