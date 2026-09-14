import { useLocalSearchParams, useRouter } from 'expo-router';

import { FootprintAlbumScreen } from '@/src/features/daily/footprints';

function parseFootprintId(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw || null;
}

export default function FootprintAlbumRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = parseFootprintId(params.id);

  if (id === null) return null;

  return (
    <FootprintAlbumScreen
      footprintId={id}
      onBack={() => router.back()}
      onEdit={() => router.push({ pathname: '/daily/footprint-edit', params: { id } })}
    />
  );
}
