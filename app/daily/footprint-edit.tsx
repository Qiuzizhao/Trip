import { useLocalSearchParams, useRouter } from 'expo-router';

import { FootprintEditorScreen } from '@/src/features/daily/footprints';

function parseFootprintId(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw || null;
}

export default function FootprintEditRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();

  return (
    <FootprintEditorScreen
      footprintId={parseFootprintId(params.id)}
      onBack={() => router.back()}
    />
  );
}
