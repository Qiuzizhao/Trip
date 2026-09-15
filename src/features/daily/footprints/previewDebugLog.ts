// 临时埋点（诊断完删除）：把预览手势过程写进 App 沙盒里的文件，
// 这样 Release 包也能在宿主机上读日志。
import * as FileSystem from 'expo-file-system/legacy';

let lines: string[] = [];
let scheduled = false;

export function debugLog(message: string) {
  lines.push(`${Date.now() % 10000000} ${message}`);
  if (lines.length > 600) lines = lines.slice(-600);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    const dir = FileSystem.documentDirectory;
    if (!dir) return;
    void FileSystem.writeAsStringAsync(`${dir}preview-debug.log`, `${lines.join('\n')}\n`, {
      encoding: 'utf8',
    }).catch(() => undefined);
  }, 200);
}
