// 同步进度上报：给「同步中」弹窗提供一份可直接渲染的进度快照。
//
// 四个阶段共享同一条 0-100 的整体进度，区间按 runManualSync 的真实顺序排：
//   上传足迹记录 0-25 → 同步照片资产 25-70 → 修复历史空图 70-85 → 拉取云端记录 85-100
// 照片资产阶段内部还分「上传 / 下载」两段，用 stepText 把当前计数显示在步骤行上。
// 纯函数，不碰 IO，方便单测直接跑。

export type SyncPhase = 'records' | 'assets' | 'repair' | 'merge';

export const SYNC_PHASE_ORDER: SyncPhase[] = ['records', 'assets', 'repair', 'merge'];

export const SYNC_PHASE_LABEL: Record<SyncPhase, string> = {
  records: '上传足迹记录',
  assets: '同步照片资产',
  repair: '修复历史空图',
  merge: '拉取云端记录',
};

export const SYNC_PHASE_RANGE: Record<SyncPhase, { start: number; end: number }> = {
  records: { start: 0, end: 25 },
  assets: { start: 25, end: 70 },
  repair: { start: 70, end: 85 },
  merge: { start: 85, end: 100 },
};

export type SyncProgress = {
  phase: SyncPhase;
  /** 整体进度 0-100 */
  percent: number;
  /** 阶段内已完成数 */
  done: number;
  /** 阶段内总数；null 表示这一阶段没有可数的总量 */
  total: number | null;
  /** 阶段内比例 0-1 */
  ratio: number;
  /** 一行中文说明，例如「同步照片资产 · 上传 3/12 张」 */
  detail: string;
  /** 步骤行右侧要显示的计数文本（阶段内部再分段时用，比如上传/下载各自计数） */
  stepText?: string;
};

export type SyncProgressListener = (progress: SyncProgress) => void;

export type SyncStepState = 'done' | 'active' | 'pending';

export function clampRatio(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function phasePercent(phase: SyncPhase, ratio: number) {
  const { start, end } = SYNC_PHASE_RANGE[phase];
  return Math.round(start + (end - start) * clampRatio(ratio));
}

export function phaseDetail(phase: SyncPhase, done: number, total: number | null, unit = '') {
  const label = SYNC_PHASE_LABEL[phase];
  if (total === null || total <= 0) return label;
  return `${label} ${Math.min(Math.max(done, 0), total)}/${total}${unit}`;
}

/** 有明确总量的阶段：按完成数推进 */
export function countProgress(phase: SyncPhase, done: number, total: number, unit = ''): SyncProgress {
  const safeTotal = Math.max(0, Math.round(total));
  const safeDone = Math.min(Math.max(Math.round(done), 0), safeTotal);
  // 总数是 0 说明这一阶段没活要干，直接算完成，进度不要卡在这里
  const ratio = safeTotal > 0 ? clampRatio(safeDone / safeTotal) : 1;
  return {
    phase,
    done: safeDone,
    total: safeTotal,
    ratio,
    percent: phasePercent(phase, ratio),
    detail: phaseDetail(phase, safeDone, safeTotal, unit),
  };
}

/** 没有可数总量的阶段：显式给比例、文案，必要时再单独给一个步骤计数文本 */
export function ratioProgress(
  phase: SyncPhase,
  ratio: number,
  detail?: string,
  stepText?: string,
): SyncProgress {
  const safeRatio = clampRatio(ratio);
  return {
    phase,
    done: 0,
    total: null,
    ratio: safeRatio,
    percent: phasePercent(phase, safeRatio),
    detail: detail || SYNC_PHASE_LABEL[phase],
    stepText,
  };
}

/** 收尾：整体 100%，弹窗切到完成态 */
export const SYNC_PROGRESS_COMPLETE: SyncProgress = {
  phase: 'merge',
  done: 0,
  total: null,
  ratio: 1,
  percent: 100,
  detail: '同步完成',
};

/** 步骤行状态：靠阶段顺序推导，已完成的阶段打勾，当前阶段转圈，后面留空 */
export function phaseStepState(phase: SyncPhase, current: SyncPhase | null, completed: boolean): SyncStepState {
  if (completed) return 'done';
  if (!current) return 'pending';
  const currentIndex = SYNC_PHASE_ORDER.indexOf(current);
  const index = SYNC_PHASE_ORDER.indexOf(phase);
  if (index < currentIndex) return 'done';
  if (index === currentIndex) return 'active';
  return 'pending';
}
