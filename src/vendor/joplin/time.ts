// 本地替身：上游 packages/lib/time.ts 依赖 moment，这里只实现被 vendor 代码用到的部分。
const time = {
  unixMs: () => Date.now(),
  msleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  sleep: (seconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, seconds * 1000); }),
};

export default time;
