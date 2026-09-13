// 本地替身：上游 models/Setting.ts（1502 行）。
// vendor 代码只用到两个键：'sync.maxConcurrentConnections'（并发上限）与 'sync.target'（用于判断增强 delta）。
// 'sync.target' 返回 null 是有意的：使 enableEnhancedBasicDeltaAlgorithm() 走到 else 分支返回 false。
const values: Record<string, unknown> = {
  'sync.maxConcurrentConnections': 3,
};

export default {
  value(key: string) {
    return values[key] ?? null;
  },
};
