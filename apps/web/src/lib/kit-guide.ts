import skill from "../../../../kit/.claude/skills/hongbao-judge/SKILL.md?raw";

// What the help pages say from the kit's own words (docs/kit-guide-design.md
// §3, §8): the lines between two marks in the Skill, the same in
// kit/AGENTS.md (a test holds them).

const marked = (name: string) =>
  skill
    .slice(
      skill.indexOf("\n", skill.indexOf(`<!-- ${name}：`)) + 1,
      skill.indexOf(`<!-- ${name}到这里 -->`),
    )
    .trim();

export const keyPoints = marked("要点");

/** One row of 选做法; its cells keep the table's own marks. */
export type Approach = {
  need: string;
  name: string;
  write: string;
  cost: string;
  read: string;
};

export const approaches: Approach[] = marked("选做法")
  .split("\n")
  .slice(2) // the header and its rule
  .map((line) => {
    const [need, name, write, cost, read] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    return {
      need: need ?? "",
      name: name ?? "",
      write: write ?? "",
      cost: cost ?? "",
      read: read ?? "",
    };
  });

/** 选做法 as lines of a prompt. */
export const approachLines = approaches
  .map(
    (row) =>
      `- ${row.need} → ${row.name}：${row.write}；费用：${row.cost}；接着读：${row.read}`,
  )
  .join("\n");
