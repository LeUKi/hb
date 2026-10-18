import { describe, expect, it } from "vitest";
import {
  decodeActivityEmoji,
  encodeActivityEmoji,
  FORUM_EMOJI,
  fromForumEmoji,
} from "../src";
import { ECOJI_V2_ALPHABET } from "../src/ecoji-v2/alphabet";

const nameOf = new Map([...FORUM_EMOJI].map(([name, emoji]) => [emoji, name]));
const forum = (text: string) =>
  [...text].map((emoji) => `:${nameOf.get(emoji)}:`).join("");

describe("emoji as the forum writes them", () => {
  it("names every emoji a link can hold, each once", () => {
    expect(FORUM_EMOJI.size).toBe(1026);
    expect([...FORUM_EMOJI.values()].sort()).toEqual(
      [...ECOJI_V2_ALPHABET, "☕", "🖼️"].sort(),
    );
  });

  it("puts a copied 红包 path back, as captured on the forum", () => {
    const restored = fromForumEmoji(
      "/:red_envelope:/:chart_decreasing::window::virgo::pizza::robot::elevator::t_rex::wheel::smiling_face_with_sunglasses::tomato::face_with_hand_over_mouth::mahjong_red_dragon::old_woman::hot_beverage:",
    );
    expect(restored).toBe("/🧧/📉🪟♍🍕🤖🛗🦖🛞😎🍅🤭🀄👵☕");
    expect(decodeActivityEmoji(restored.split("/")[2] ?? "")).toBe(
      "7e285028-8dda-426f-8028-b0c7de000069",
    );
  });

  it("round-trips any code, and the image path", () => {
    const code = encodeActivityEmoji("550e8400-e29b-41d4-a716-446655440000");
    expect(fromForumEmoji(forum(code))).toBe(code);
    expect(fromForumEmoji(":piñata::framed_picture:")).toBe("🪅🖼️");
  });

  it("leaves other text alone", () => {
    for (const text of [
      "https://hb.lafi.sh/history",
      "10:30:00",
      ":not_an_emoji:",
      "周末口令2026",
    ])
      expect(fromForumEmoji(text)).toBe(text);
    expect(fromForumEmoji("x :not_an_emoji::red_envelope:")).toBe(
      "x :not_an_emoji:🧧",
    );
  });
});
