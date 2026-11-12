import type { Battle, Point, Skill, Unit } from "../../../shared/types";
import { clone, distance, findUnit, key } from "../../../shared/document";
import { reachable } from "../../terrain/lib/paths";
import { terrainRules } from "../../terrain/lib/cost";
import { armorValue, moveBudget } from "../../roster/lib/status";
import { skillBook } from "../../tactics/model/skills";
import { legalTargets } from "../../tactics/lib/targeting";
import { previewDamage } from "../../tactics/lib/damage";

export interface PlanStep {
  kind: "move" | "skill" | "wait";
  path?: Point[];
  skillId?: string;
  targetId?: string;
  label: string;
}

export interface PlanResult {
  actorId: string;
  steps: PlanStep[];
  score: number;
  rationale: string;
  nodes: number;
  budget: number;
  complete: boolean;
  signature: string;
}

export interface PlanToken {
  cancelled: boolean;
}

/**
 * 局面签名：规划所依赖的全部真实状态。
 * 确认执行前重新计算，任何地形/单位/顺序变化都会使旧方案失效。
 */
export function battleSignature(b: Battle): string {
  const units = b.units
    .map(
      (u) =>
        `${u.id}:${u.hp}:${u.x},${u.y}:${u.moved ? 1 : 0}:${u.acted ? 1 : 0}:${u.statuses
          .map((s) => s.kind + s.turns)
          .join(".")}`,
    )
    .join("|");
  const tiles = b.tiles.map((t) => `${t.x},${t.y}${t.terrain}`).join("|");
  return [
    b.round,
    b.active,
    b.queue.join(","),
    b.ended ?? "",
    units,
    tiles,
  ].join("#");
}

interface Candidate {
  movePath: Point[];
  skill?: Skill;
  targetId?: string;
  score: number;
  label: string;
  steps: number;
  cost: number;
  seq: number;
}

function isBetter(a: Candidate, b: Candidate): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.steps !== b.steps) return a.steps < b.steps;
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.label !== b.label) return a.label < b.label;
  return a.seq < b.seq;
}

/** 无技能动作的站位收益：利用掩护、接近并进入攻击射程。 */
function positionScore(b: Battle, u: Unit): number {
  const enemies = b.units.filter((v) => v.hp > 0 && v.team !== u.team);
  if (!enemies.length) return 0;
  const tile = b.tiles.find((t) => key(t) === key(u))!;
  const attackRanges = skillBook[u.job]
    .filter((s) => s.target === "enemy")
    .map((s) => s.range);
  const maxRange = Math.max(...attackRanges);
  const nearest = Math.min(...enemies.map((e) => distance(u, e)));
  const inRange = enemies.some((e) => distance(u, e) <= maxRange);
  return (
    terrainRules[tile.terrain].cover * 3 +
    (inRange ? 10 : 0) +
    Math.max(0, 6 - nearest) * 2
  );
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

/**
 * 在节点预算内搜索当前行动角色的最佳合法方案（移动后攻击 / 治疗 / 增益 / 保留站位）。
 * 只规划当前一个行动轮，不枚举未来回合。
 * 候选顺序完全由局面决定，分块仅用于让出主线程，不改变评估集合与结果。
 * 返回 null 表示被取消；预算耗尽时返回当前最佳且 complete=false。
 */
export async function planCommand(
  battle: Battle,
  budget: number,
  token: PlanToken,
  chunkSize = 20,
): Promise<PlanResult | null> {
  const b = clone(battle);
  const actor = findUnit(b, b.active);
  if (actor.hp <= 0 || b.ended) return null;
  // 已移动或已施法的角色不能再移动；已施法的角色只能待命。
  const canMove = !actor.moved && !actor.acted;
  const reach = canMove
    ? reachable(b, actor, moveBudget(actor))
    : new Map([[key(actor), { cost: 0, path: [] as Point[] }]]);
  // reachable 的 Map 以角色所在格为首项，后续顺序由固定方向的 Dijkstra 决定，天然确定。
  const positions = [...reach.entries()];
  const skills = actor.acted ? [] : skillBook[actor.job];

  let nodes = 0;
  let best: Candidate | null = null;
  let sinceYield = 0;
  let truncated = false;

  const consider = (c: Candidate) => {
    nodes += 1;
    if (!best || isBetter(c, best)) best = c;
  };

  outer: for (const [, route] of positions) {
    const sim = clone(b);
    const simActor = findUnit(sim, actor.id);
    const moved = route.path.length > 0;
    const dest: Point = moved ? route.path[route.path.length - 1] : simActor;
    if (moved) {
      simActor.x = dest.x;
      simActor.y = dest.y;
      simActor.moved = true;
    }

    // 选项 1：不施法，仅移动或原地待命（始终合法，保证任意预算下都有方案）。
    if (nodes >= budget) {
      truncated = true;
      break outer;
    }
    consider({
      movePath: clone(route.path),
      score: positionScore(sim, simActor),
      label: moved
        ? `移动至 ${dest.x + 1}·${dest.y + 1} 保持阵位`
        : "原地待命，保留站位",
      steps: moved ? 1 : 0,
      cost: route.cost,
      seq: nodes,
    });

    // 选项 2：在该站位下使用每个技能的每个合法目标。
    for (const s of skills) {
      const targets = legalTargets(sim, simActor, s).sort((a, c) =>
        a.id.localeCompare(c.id),
      );
      for (const t of targets) {
        if (nodes >= budget) {
          truncated = true;
          break outer;
        }
        const ground = sim.tiles.find((v) => key(v) === key(t))!;
        const elevated =
          sim.tiles.find((v) => key(v) === key(simActor))!.terrain === "ridge";
        const value = previewDamage(
          simActor,
          t,
          s,
          armorValue(t),
          terrainRules[ground.terrain].cover,
          elevated,
        );
        let score: number | null = null;
        let label = "";
        if (s.target === "ally") {
          // 满血治疗没有收益，跳过但仍计入评估节点。
          if (value <= 0) {
            nodes += 1;
          } else {
            score = value * 8 + (t.hp < t.maxHp * 0.5 ? 15 : 0);
            label = `${s.name} 治疗 ${t.name}，恢复 ${value} 点`;
          }
        } else if (s.target === "self") {
          if (s.status && simActor.statuses.some((x) => x.kind === s.status)) {
            nodes += 1;
          } else {
            score = 18;
            label = `${s.name} 强化自身`;
          }
        } else {
          const kill = value >= t.hp;
          score =
            value * 10 +
            (kill ? 80 : 0) +
            (s.status && !kill ? 12 : 0);
          label = `${s.name} 攻击 ${t.name}，造成 ${value} 点${kill ? "（击杀）" : ""}`;
        }
        if (score === null) {
          if (++sinceYield >= chunkSize) {
            await yieldFrame();
            sinceYield = 0;
            if (token.cancelled) return null;
          }
          continue;
        }
        consider({
          movePath: clone(route.path),
          skill: s,
          targetId: t.id,
          score,
          label,
          steps: (moved ? 1 : 0) + 1,
          cost: route.cost,
          seq: nodes,
        });
        if (++sinceYield >= chunkSize) {
          await yieldFrame();
          sinceYield = 0;
          if (token.cancelled) return null;
        }
      }
    }
  }

  if (token.cancelled || !best) return null;
  const chosen: Candidate = best;

  const steps: PlanStep[] = [];
  if (chosen.movePath.length) {
    const end = chosen.movePath[chosen.movePath.length - 1];
    steps.push({
      kind: "move",
      path: clone(chosen.movePath),
      label: `${actor.name} 移动 ${chosen.movePath.length} 格至 ${end.x + 1}·${end.y + 1}`,
    });
  }
  if (chosen.skill) {
    steps.push({
      kind: "skill",
      skillId: chosen.skill.id,
      targetId: chosen.targetId,
      label: `${actor.name} ${chosen.label}`,
    });
  }
  steps.push({ kind: "wait", label: `${actor.name} 结束行动` });

  return {
    actorId: actor.id,
    steps,
    score: chosen.score,
    rationale: chosen.label,
    nodes,
    budget,
    complete: !truncated,
    signature: battleSignature(battle),
  };
}
