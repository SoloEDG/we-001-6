import { computed, reactive, ref } from "vue";
import type { Point, Terrain } from "../shared/types";
import { clone, findUnit, key } from "../shared/document";
import { reachable, terrainRules, paintTile } from "../features/terrain";
import { moveBudget, armorValue, tickStatuses } from "../features/roster";
import {
  getSkill,
  legalTargets,
  moveUnit,
  castSkill,
} from "../features/tactics";
import { finishTurn } from "../features/initiative";
import {
  record,
  frame,
  loadArchive,
  saveArchive,
  usePlayback,
} from "../features/replay";
import {
  battleSignature,
  planCommand,
  type PlanResult,
  type PlanToken,
} from "../features/command";
import { newSession } from "./session";

const AUTO_KEY = "we001-auto-command";
const BUDGET_KEY = "we001-plan-budget";

export function useWorkspace() {
  const session = reactive(loadArchive() ?? newSession());
  const cursor = ref(-1),
    selected = ref(session.live.active),
    skill = ref(""),
    brush = ref<Terrain | null>(null),
    notice = ref("选择蓝色格移动，或选择技能指定目标。");
  const autoCommand = ref(localStorage.getItem(AUTO_KEY) === "1");
  const planBudget = ref(Number(localStorage.getItem(BUDGET_KEY)) || 200);
  const plan = ref<PlanResult | null>(null);
  const planning = ref(false);
  let token: PlanToken | null = null;

  const playback = usePlayback(
    () => session.events.length,
    (n) => {
      cursor.value = n;
    },
  );
  const battle = computed(() => frame(session, cursor.value));
  const actor = computed(() => findUnit(battle.value, battle.value.active));
  const locked = computed(() => cursor.value >= 0 || !!session.live.ended);
  const routes = computed(() =>
    locked.value || actor.value.moved || actor.value.acted
      ? new Map()
      : reachable(session.live, actor.value, moveBudget(actor.value)),
  );
  const targets = computed(() => {
    const s = getSkill(actor.value.job, skill.value);
    return s ? legalTargets(battle.value, actor.value, s) : [];
  });

  // 方案只有在与当前实战局面签名一致时才有效：地形编辑、切历史、目标死亡等都会使其失效。
  const planValid = computed(
    () =>
      !!plan.value &&
      !planning.value &&
      plan.value.actorId === session.live.active &&
      plan.value.signature === battleSignature(session.live),
  );
  const planPath = computed(() =>
    planValid.value
      ? plan.value!.steps.find((s) => s.kind === "move")?.path ?? []
      : [],
  );
  const planTarget = computed(() =>
    planValid.value
      ? plan.value!.steps.find((s) => s.kind === "skill")?.targetId ?? ""
      : "",
  );
  const planTargetName = computed(() => {
    const id = planTarget.value;
    return id ? session.live.units.find((u) => u.id === id)?.name ?? "" : "";
  });

  function invalidatePlan(reason: string) {
    if (token) token.cancelled = true;
    token = null;
    planning.value = false;
    plan.value = null;
    if (reason) notice.value = reason;
  }

  function maybeAutoPlan() {
    if (
      autoCommand.value &&
      !locked.value &&
      session.live.active &&
      findUnit(session.live, session.live.active).team === "ember"
    ) {
      void startPlanning();
    }
  }

  async function startPlanning() {
    if (planning.value || locked.value || session.live.ended) return;
    invalidatePlan("");
    const myToken: PlanToken = { cancelled: false };
    token = myToken;
    planning.value = true;
    notice.value = "自动指挥正在规划……";
    const snapshot = clone(session.live);
    const budget = planBudget.value;
    const result = await planCommand(snapshot, budget, myToken);
    // 规划期间若地形被编辑、切到历史或开始新规划，token 已被置为取消或替换。
    if (myToken.cancelled || token !== myToken) return;
    token = null;
    planning.value = false;
    if (!result) return;
    if (result.signature !== battleSignature(session.live)) {
      notice.value = "规划期间局面已变化，方案已作废，请重新规划。";
      return;
    }
    plan.value = result;
    notice.value = `自动方案就绪：${result.rationale}，确认后执行。`;
  }

  function cancelPlanning() {
    if (!planning.value) return;
    invalidatePlan("已取消规划，未写入任何行动。");
  }

  function toggleAuto() {
    autoCommand.value = !autoCommand.value;
    localStorage.setItem(AUTO_KEY, autoCommand.value ? "1" : "0");
    invalidatePlan("");
    if (autoCommand.value) maybeAutoPlan();
  }

  function changeBudget(n: number) {
    planBudget.value = n;
    localStorage.setItem(BUDGET_KEY, String(n));
    invalidatePlan("搜索预算已变更，请重新规划。");
    maybeAutoPlan();
  }

  function dismissPlan() {
    invalidatePlan("已放弃自动方案。");
  }

  /**
   * 确认执行：先在克隆上完整模拟整套方案，任一步不合法即整体中止、零写入；
   * 模拟通过后再沿与手动操作完全相同的战斗流程逐步提交并生成回放。
   */
  function confirmPlan() {
    const current = plan.value;
    if (locked.value || !planValid.value || !current) {
      notice.value = "方案已失效，无法执行，请重新规划。";
      plan.value = null;
      return;
    }
    const moveStep = current.steps.find((s) => s.kind === "move");
    const skillStep = current.steps.find((s) => s.kind === "skill");
    try {
      if (current.signature !== battleSignature(session.live))
        throw new Error("局面已变化，旧方案失效");
      const actor0 = findUnit(session.live, session.live.active);
      if (actor0.hp <= 0) throw new Error("行动角色已阵亡，需要重新规划");

      // —— 第一阶段：克隆上完整模拟，不触碰实战与回放 ——
      const sim = clone(session.live);
      const simActor = findUnit(sim, sim.active);
      let simPath: Point[] = [];
      let simCost = 0;
      if (moveStep?.path?.length) {
        const route = reachable(sim, simActor, moveBudget(simActor)).get(
          key(moveStep.path[moveStep.path.length - 1]),
        );
        if (!route || JSON.stringify(route.path) !== JSON.stringify(moveStep.path))
          throw new Error("移动路径已不合法，旧方案失效");
        moveUnit(sim, simActor.id, route.path);
        simPath = route.path;
        simCost = route.cost;
      }
      let skillInfo: { sName: string; tName: string; value: number } | null =
        null;
      if (skillStep?.skillId && skillStep.targetId) {
        const a = findUnit(sim, sim.active);
        const s = getSkill(a.job, skillStep.skillId);
        const t = sim.units.find(
          (v) => v.hp > 0 && v.id === skillStep.targetId,
        );
        if (!s || !t) throw new Error("技能或目标已不存在，旧方案失效");
        if (!legalTargets(sim, a, s).some((v) => v.id === t.id))
          throw new Error("目标已不在合法范围内，旧方案失效");
        const ground = sim.tiles.find((v) => key(v) === key(t))!;
        const high =
          sim.tiles.find((v) => key(v) === key(a))!.terrain === "ridge";
        const value = castSkill(
          sim,
          a.id,
          t.id,
          s,
          armorValue(t),
          terrainRules[ground.terrain].cover,
          high,
        );
        skillInfo = { sName: s.name, tName: t.name, value };
      }
      const waiterName = findUnit(sim, sim.active).name;
      finishTurn(sim, tickStatuses);

      // —— 第二阶段：模拟全部合法，按正常流程逐步写入实战并记录回放 ——
      const targetId = skillStep?.targetId ?? "";
      const skillId = skillStep?.skillId ?? "";
      const liveActor = findUnit(session.live, session.live.active);
      if (simPath.length) {
        const before = clone(session.live);
        const route = reachable(session.live, liveActor, moveBudget(liveActor)).get(
          key(simPath[simPath.length - 1]),
        )!;
        moveUnit(session.live, liveActor.id, route.path);
        record(
          session,
          before,
          "move",
          `${liveActor.name}移动 · 消耗${simCost}`,
          route.path,
        );
      }
      if (skillInfo) {
        const before = clone(session.live);
        const a = findUnit(session.live, session.live.active);
        const t = session.live.units.find((v) => v.id === targetId)!;
        const ground = session.live.tiles.find((v) => key(v) === key(t))!;
        const high =
          session.live.tiles.find((v) => key(v) === key(a))!.terrain ===
          "ridge";
        castSkill(
          session.live,
          a.id,
          t.id,
          getSkill(a.job, skillId)!,
          armorValue(t),
          terrainRules[ground.terrain].cover,
          high,
        );
        record(
          session,
          before,
          "skill",
          `${a.name} → ${t.name} · ${skillInfo.sName} ${skillInfo.value}`,
        );
      }
      const beforeWait = clone(session.live);
      finishTurn(session.live, tickStatuses);
      record(session, beforeWait, "wait", `${waiterName}结束行动`);

      plan.value = null;
      skill.value = "";
      selected.value = session.live.active;
      saveArchive(session);
      notice.value = "自动方案已执行并写入回放。";
      maybeAutoPlan();
    } catch (e) {
      plan.value = null;
      notice.value = (e as Error).message + "，未执行任何行动。";
    }
  }

  function cell(p: Point) {
    try {
      if (locked.value) throw new Error("回放只读，请返回实战");
      const before = clone(session.live),
        u = actor.value;
      if (brush.value) {
        paintTile(session.live, p, brush.value);
        record(
          session,
          before,
          "terrain",
          `地形调整为${terrainRules[brush.value].name}`,
        );
        // 地形变化使任何进行中或已完成的方案立即失效。
        invalidatePlan("地形已变更，原自动方案失效。");
        maybeAutoPlan();
      } else if (skill.value) {
        const s = getSkill(u.job, skill.value)!;
        const t = session.live.units.find((t) => t.hp > 0 && key(t) === key(p));
        if (!t) throw new Error("请点击合法角色");
        const ground = session.live.tiles.find((v) => key(v) === key(t))!;
        const high =
          session.live.tiles.find((v) => key(v) === key(u))!.terrain ===
          "ridge";
        const value = castSkill(
          session.live,
          u.id,
          t.id,
          s,
          armorValue(t),
          terrainRules[ground.terrain].cover,
          high,
        );
        record(
          session,
          before,
          "skill",
          `${u.name} → ${t.name} · ${s.name} ${value}`,
        );
        skill.value = "";
        invalidatePlan("");
      } else {
        const route = routes.value.get(key(p));
        if (!route?.path.length)
          throw new Error("此格不可达，请检查地形与占位");
        moveUnit(session.live, u.id, route.path);
        record(
          session,
          before,
          "move",
          `${u.name}移动 · 消耗${route.cost}`,
          route.path,
        );
        invalidatePlan("");
      }
      saveArchive(session);
      notice.value = session.events.at(-1)!.label;
    } catch (e) {
      notice.value = (e as Error).message;
    }
  }
  function wait() {
    if (locked.value) return;
    const before = clone(session.live);
    finishTurn(session.live, tickStatuses);
    record(
      session,
      before,
      "wait",
      `${findUnit(before, before.active).name}结束行动`,
    );
    selected.value = session.live.active;
    skill.value = "";
    invalidatePlan("");
    saveArchive(session);
    maybeAutoPlan();
  }
  function seek(n: number) {
    playback.stop();
    cursor.value = n;
    skill.value = "";
    brush.value = null;
    invalidatePlan(n >= 0 ? "已切换到历史步骤，自动方案暂停生效。" : "");
    if (n < 0) maybeAutoPlan();
  }
  function reset() {
    playback.stop();
    Object.assign(session, newSession());
    cursor.value = -1;
    selected.value = session.live.active;
    skill.value = "";
    brush.value = null;
    invalidatePlan("");
    saveArchive(session);
    notice.value = "新战斗已就绪";
    maybeAutoPlan();
  }
  const path = computed(() =>
    cursor.value > 0 ? (session.events[cursor.value - 1]?.path ?? []) : [],
  );

  return {
    session,
    cursor,
    selected,
    skill,
    brush,
    notice,
    battle,
    actor,
    locked,
    routes,
    targets,
    path,
    playback,
    autoCommand,
    planBudget,
    plan,
    planning,
    planValid,
    planPath,
    planTarget,
    planTargetName,
    startPlanning,
    cancelPlanning,
    toggleAuto,
    changeBudget,
    confirmPlan,
    dismissPlan,
    cell,
    wait,
    seek,
    reset,
  };
}
