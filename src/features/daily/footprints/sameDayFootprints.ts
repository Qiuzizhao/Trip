import { Alert } from 'react-native';

import { listFootprintsLocal } from '@/src/local/repositories/footprintsRepository';

type DatedFootprint = {
  visit_date?: unknown;
  location?: unknown;
  coordinate?: unknown;
  deleted_at?: unknown;
};

// visit_date is a calendar date; do not convert it through a UTC timestamp.
function dateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/.exec(value.trim());
  return match?.[1] ?? null;
}

export function footprintsOnDate<T extends DatedFootprint>(items: readonly T[], visitDate: string): T[] {
  const key = dateKey(visitDate);
  if (!key) return [];
  return items.filter((item) => !item.deleted_at && dateKey(item.visit_date) === key);
}

export async function confirmNewFootprintDate(visitDate: string): Promise<boolean> {
  // Read at send time, including any records saved or synchronized since opening the editor.
  const sameDay = footprintsOnDate(await listFootprintsLocal(), visitDate);
  if (!sameDay.length) return true;
  const details = sameDay.map((item, index) => {
    const location = String(item.location || '').trim() || '未填写';
    const city = String(item.coordinate || '').trim() || '未填写';
    return `${sameDay.length > 1 ? `${index + 1}. ` : ''}地点：${location}\n城市：${city}`;
  }).join('\n\n');
  return new Promise((resolve) => {
    Alert.alert(
      '这一天已有足迹',
      `${visitDate} 已有 ${sameDay.length} 条足迹：\n\n${details}\n\n仍要寄出这条新足迹吗？`,
      [
        { text: '返回修改', style: 'cancel', onPress: () => resolve(false) },
        { text: '继续寄出', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
