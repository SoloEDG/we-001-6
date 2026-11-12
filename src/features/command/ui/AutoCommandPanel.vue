<script setup lang="ts">
import type { Unit } from "../../../shared/types";
import type { PlanResult } from "../model/planner";
defineProps<{
  unit: Unit;
  auto: boolean;
  planning: boolean;
  plan: PlanResult | null;
  planValid: boolean;
  budget: number;
  locked: boolean;
  targetName: string;
}>();
defineEmits<{
  toggleAuto: [];
  budget: [n: number];
  plan: [];
  cancel: [];
  confirm: [];
  dismiss: [];
}>();
</script>
<template>
  <section class="panel command-panel">
    <div class="eyebrow">05 / AUTO COMMAND</div>
    <h3>
      敌方自动指挥
      <small>{{ auto ? "已接管余烬军" : "手动控制中" }}</small>
    </h3>
    <div class="command-toggle">
      <button :class="{ chosen: auto }" @click="$emit('toggleAuto')">
        {{ auto ? "◉ 自动指挥：开" : "○ 自动指挥：关" }}
      </button>
    </div>
    <label class="budget-row">
      <span>搜索预算（节点）</span>
      <select
        :value="budget"
        :disabled="planning"
        @change="$emit('budget', Number(($event.target as HTMLSelectElement).value))"
      >
        <option :value="80">80 · 快速</option>
        <option :value="200">200 · 标准</option>
        <option :value="400">400 · 深入</option>
      </select>
    </label>
    <div class="command-actions">
      <button
        v-if="!planning"
        class="primary"
        :disabled="locked"
        @click="$emit('plan')"
      >
        ▲ 规划 {{ unit.team === "ember" ? "余烬军" : "本角色" }}行动
      </button>
      <button v-else @click="$emit('cancel')">■ 取消规划</button>
    </div>
    <p v-if="planning" class="command-status" role="status">
      正在评估真实地形、职业状态与剩余行动……可随时取消。
    </p>
    <div v-else-if="plan" class="plan-card" :class="{ stale: !planValid }">
      <div class="plan-head">
        <b>{{ planValid ? "待确认方案" : "方案已失效" }}</b>
        <small
          >{{ plan.nodes }}/{{ plan.budget }} 节点 ·
          {{ plan.complete ? "评估完整" : "预算截断" }} · 评分
          {{ plan.score }}</small
        >
      </div>
      <p class="plan-rationale">{{ plan.rationale }}</p>
      <ol class="plan-steps">
        <li v-for="(s, i) in plan.steps" :key="i">{{ s.label }}</li>
      </ol>
      <p v-if="!planValid" class="plan-stale-note">
        地形、单位或行动顺序已变化，旧方案不会执行，请重新规划。
      </p>
      <p v-else-if="targetName" class="plan-target">
        ◈ 地图已标注目标：{{ targetName }}
      </p>
      <div class="plan-buttons" v-if="planValid && !locked">
        <button class="primary" @click="$emit('confirm')">确认并执行</button
        ><button @click="$emit('dismiss')">放弃方案</button>
      </div>
    </div>
    <p v-else class="command-hint">
      规划器在预算内返回当前最佳合法方案，不枚举未来回合；确认后走正常战斗流程并生成回放。
    </p>
  </section>
</template>
