/** Recovery builds retain new date-config readers while disabling new entry points. */
export const activityToolsEnabled =
  import.meta.env.VITE_ACTIVITY_TOOLS_RECOVERY !== "1";
