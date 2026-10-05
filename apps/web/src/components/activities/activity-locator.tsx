import { normalizeTopicLink } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "../ui/button";

export function ActivityLocator() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  function locate() {
    setError(null);
    const input = value.trim();
    if (z.uuid().safeParse(input).success) {
      void navigate({
        to: "/activities/$id",
        params: { id: input.toLowerCase() },
      });
      return;
    }
    const topic = normalizeTopicLink(input);
    if (topic) {
      void navigate({
        to: "/topics/$topicId",
        params: { topicId: topic.topicId },
        search: { postNumber: topic.postNumber },
      });
      return;
    }
    try {
      const url = new URL(input);
      const match = /^\/activities\/([^/]+)\/?$/.exec(url.pathname);
      if (
        url.origin === window.location.origin &&
        !url.username &&
        !url.password &&
        match?.[1] &&
        z.uuid().safeParse(match[1]).success
      ) {
        void navigate({
          to: "/activities/$id",
          params: { id: match[1].toLowerCase() },
        });
        return;
      }
    } catch {
      /* Invalid input is reported below. */
    }
    setError("请输入活动 UUID、本网站的活动链接，或 Linux DO 帖子链接。");
  }
  return (
    <details className="activity-panel">
      <summary className="cursor-pointer font-medium">定位活动</summary>
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          locate();
        }}
      >
        <label className="activity-label" htmlFor="activity-location">
          活动 ID 或链接
          <input
            id="activity-location"
            className="activity-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="UUID、活动链接或 Linux DO 帖子链接"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <Button type="submit">前往活动</Button>
      </form>
    </details>
  );
}
