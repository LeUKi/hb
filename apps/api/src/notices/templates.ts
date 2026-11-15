// What each 私信通知 says (docs/notification-design.md §6): a subject that
// says it all, a few short lines, one link, and where to turn it off.

import { encodeActivityEmoji } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { bodyOf, nameOf, subjectOf, timeOf } from "./text";

export type Notice = { subject: string; body: string };

function originOf(env: Pick<ApiBindings, "APP_ORIGIN">) {
  return (env.APP_ORIGIN || "https://hb.lafi.sh").replace(/\/+$/, "");
}

export function hongbaoUrl(env: Pick<ApiBindings, "APP_ORIGIN">, id: string) {
  return `${originOf(env)}/🧧/${encodeActivityEmoji(id)}`;
}

function off(env: Pick<ApiBindings, "APP_ORIGIN">) {
  return `${originOf(env)}/notifications`;
}

const points = (name: string) => nameOf(name, "「", "」");

/** 限时开奖中了: the prize, and where it goes. */
export function drawWon(
  env: ApiBindings,
  input: {
    activityId: string;
    title: string;
    amount: string;
    funding: "merchant" | "balance" | "points";
  },
): Notice {
  const where =
    input.funding === "balance"
      ? "已经存进你的🐟额。"
      : input.funding === "points"
        ? "会发到你在对方网站的账户。"
        : "会付到你的 Credit。";
  return {
    subject: subjectOf(`你在${nameOf(input.title)}中了 ${input.amount}`),
    body: bodyOf(
      [`${nameOf(input.title)}开奖了，你中了 ${input.amount}，${where}`],
      { label: "开奖结果", url: hongbaoUrl(env, input.activityId) },
      off(env),
    ),
  };
}

/** 红包付不出钱: once a 红包, the reason it stopped first. */
export function payoutStuck(
  env: ApiBindings,
  input: {
    activityId: string;
    title: string;
    waiting: number;
    reason: "funds" | "quota";
  },
): Notice {
  const name = nameOf(input.title);
  const people =
    input.waiting > 1 ? `有 ${input.waiting} 个人领了` : "有人领了";
  return input.reason === "funds"
    ? {
        subject: subjectOf(`${name}付不出钱，Credit 余额不够`),
        body: bodyOf(
          [
            `${name}${people}，还没付出去：你的 Credit 余额不够。补上以后会自动接着付。这个红包只提醒这一次。`,
          ],
          { label: "去看看", url: hongbaoUrl(env, input.activityId) },
          off(env),
        ),
      }
    : {
        subject: subjectOf(`${name}付不出钱，今天的限额用完了`),
        body: bodyOf(
          [
            `${name}${people}，还没付出去：你的 Credit 今天能付出的额度用完了。明天 0 点过后会自动接着付。这个红包只提醒这一次。`,
          ],
          { label: "去看看", url: hongbaoUrl(env, input.activityId) },
          off(env),
        ),
      };
}

/** 定时开放没开成: why, as the 红包 page says it. */
export function scheduleFailed(
  env: ApiBindings,
  input: { activityId: string; title: string; reason: string },
): Notice {
  const name = nameOf(input.title);
  return {
    subject: subjectOf(`${name}定时开放没开成`),
    body: bodyOf(
      [
        `${name}到点没能开放：${input.reason.replace(/[。.]$/u, "")}。已经退回草稿，可以重新定时，或者直接开放。`,
      ],
      { label: "去看看", url: hongbaoUrl(env, input.activityId) },
      off(env),
    ),
  };
}

/** 红包被站长停用. */
export function hongbaoStopped(
  env: ApiBindings,
  input: { activityId: string; title: string; refunds: boolean },
): Notice {
  const name = nameOf(input.title);
  return {
    subject: subjectOf(`${name}被站长停用了`),
    body: bodyOf(
      [
        `你的${name}被站长停用，不能再领了。${input.refunds ? "没发出去的🐟会退回你的🐟额。" : ""}`,
      ],
      { label: "去看看", url: hongbaoUrl(env, input.activityId) },
      off(env),
    ),
  };
}

export type PointsStop =
  | "insufficient"
  | "key_invalid"
  | "key_removed"
  | "retired";

/** 三方积分红包提前结束: why, in the sender's words. */
export function pointsHongbaoEnded(
  env: ApiBindings,
  input: {
    activityId: string;
    title: string;
    system: string;
    stop: PointsStop;
    /** A 限时开奖 stopped before its draw. */
    beforeDraw: boolean;
  },
): Notice {
  const name = nameOf(input.title);
  const system = points(input.system);
  const why = {
    insufficient: `${system}余额不够`,
    key_invalid: `${system}的密钥失效了`,
    key_removed: `${system}的密钥删掉了`,
    retired: `${system}被下架了`,
  }[input.stop];
  return {
    subject: subjectOf(`${name}提前结束了：${why}`),
    body: bodyOf(
      [
        input.beforeDraw
          ? `${name}开奖前查了一次，${why}，所以没有开奖，红包结束了。`
          : `${name}提前结束了：${why}。已经发出去的照常，剩下的不再发。`,
      ],
      { label: "去看看", url: hongbaoUrl(env, input.activityId) },
      off(env),
    ),
  };
}

/** 收到打赏. */
export function tipReceived(
  env: ApiBindings,
  input: { tipper: string | null; amount: string; message: string | null },
): Notice {
  const who = input.tipper ? `@${input.tipper}` : "有位游客";
  const message = input.message?.trim();
  return {
    subject: subjectOf(`${who} 打赏了你 ${input.amount}`),
    body: bodyOf(
      [
        `${who} 通过你的打赏卡打赏了你 ${input.amount}${message ? "：" : "。"}`,
        message ? `“${message}”` : "",
      ],
      { label: "去看打赏", url: `${originOf(env)}/tips` },
      off(env),
    ),
  };
}

/** 收到转账. */
export function transferReceived(
  env: ApiBindings,
  input: { sender: string; amount: string; remark: string | null },
): Notice {
  const remark = input.remark?.trim();
  return {
    subject: subjectOf(`@${input.sender} 转给你 ${input.amount}`),
    body: bodyOf(
      [
        `@${input.sender} 用🐟额转给你 ${input.amount}${remark ? "：" : "。"}`,
        remark ? `“${remark}”` : "",
      ],
      { label: "去看🐟额", url: `${originOf(env)}/balance` },
      off(env),
    ),
  };
}

/** 判定器被撤下. */
export function judgeWithdrawn(
  env: ApiBindings,
  input: { judgeId: string; name: string; reason: string },
): Notice {
  const name = nameOf(input.name);
  const reason = input.reason.trim().replace(/[。.]$/u, "");
  return {
    subject: subjectOf(`你的判定器${name}被撤下了`),
    body: bodyOf(
      [
        `站长把你的判定器${name}从判定器广场撤下了。${reason ? `原因：${reason}。` : ""}`,
        "已经开放的红包照常，新红包选不到它了。",
      ],
      {
        label: "去看判定器",
        url: `${originOf(env)}/judges/${encodeURIComponent(input.judgeId)}`,
      },
      off(env),
    ),
  };
}

/** 三方积分 审核: through, or sent back with the 站长's words. */
export function pointsReviewed(
  env: ApiBindings,
  input: {
    systemId: string;
    name: string;
    approved: boolean;
    note: string | null;
  },
): Notice {
  const name = points(input.name);
  const note = input.note?.trim().replace(/[。.]$/u, "");
  return input.approved
    ? {
        subject: subjectOf(`你添加的${name}审核通过，上线了`),
        body: bodyOf(
          [`你添加的${name}审核通过，上线了。大家发红包时已经能选它。`],
          {
            label: "去看看",
            url: `${originOf(env)}/points/${encodeURIComponent(input.systemId)}`,
          },
          off(env),
        ),
      }
    : {
        subject: subjectOf(`你添加的${name}被退回了`),
        body: bodyOf(
          [
            `你添加的${name}审核没通过，退回了。${note ? `原因：${note}。` : ""}改好以后可以再提交。`,
          ],
          {
            label: "去设置",
            url: `${originOf(env)}/points/${encodeURIComponent(input.systemId)}/edit`,
          },
          off(env),
        ),
      };
}

/** 三方积分 paused, resumed or 下架 by the 站长. */
export function pointsStatus(
  env: ApiBindings,
  input: {
    systemId: string;
    name: string;
    action: "pause" | "resume" | "retire";
  },
): Notice {
  const name = points(input.name);
  const said = {
    pause: {
      subject: `${name}被站长暂停了`,
      text: `站长暂停了你添加的${name}。暂停期间发不了新红包，也发不出积分。`,
    },
    resume: {
      subject: `${name}恢复了`,
      text: `站长恢复了你添加的${name}，又能用了。`,
    },
    retire: {
      subject: `${name}被站长下架了`,
      text: `站长下架了你添加的${name}。用它的开放中红包都已经结束。`,
    },
  }[input.action];
  return {
    subject: subjectOf(said.subject),
    body: bodyOf(
      [said.text],
      {
        label: "去看看",
        url: `${originOf(env)}/points/${encodeURIComponent(input.systemId)}`,
      },
      off(env),
    ),
  };
}

/** 三方积分's interface stopped answering: once an outage. */
export function pointsBreaker(
  env: ApiBindings,
  input: { systemId: string; name: string },
): Notice {
  const name = points(input.name);
  return {
    subject: subjectOf(`${name}的接口连不上，发放暂停了`),
    body: bodyOf(
      [
        `你添加的${name}的接口连续 5 次没有回复，发放暂停 10 分钟，之后会再试。接口恢复前不再提醒。`,
      ],
      {
        label: "去看看",
        url: `${originOf(env)}/points/${encodeURIComponent(input.systemId)}`,
      },
      off(env),
    ),
  };
}

/** 等的红包开放了: no switch, the 红包's own button was it. */
export function openingWatch(
  env: ApiBindings,
  input: {
    activityId: string;
    title: string;
    author: string;
    deadline: number | null;
  },
): Notice {
  const name = nameOf(input.title);
  return {
    subject: subjectOf(`你等的${name}开放了`),
    body: bodyOf(
      [
        `@${input.author} 的${name}开放了${input.deadline ? `，${timeOf(input.deadline)} 截止` : ""}。`,
      ],
      { label: "去领", url: hongbaoUrl(env, input.activityId) },
      null,
    ),
  };
}

/**
 * 红包广场 有新红包: the one reminder the button asked for; another needs
 * another press in the 广场.
 */
export function squareOpened(
  env: ApiBindings,
  input: {
    activityId: string;
    title: string;
    author: string;
    deadline: number | null;
  },
): Notice {
  const name = nameOf(input.title);
  return {
    subject: subjectOf(`红包广场有新红包：${name}`),
    body: bodyOf(
      [
        `@${input.author} 的${name}刚在红包广场开放${input.deadline ? `，${timeOf(input.deadline)} 截止` : ""}。`,
        "这是你在红包广场设的那一次提醒。想再收到，回红包广场再设一次。",
      ],
      { label: "去领", url: hongbaoUrl(env, input.activityId) },
      null,
    ),
  };
}
