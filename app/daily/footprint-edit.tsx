import { useLocalSearchParams, useRouter } from 'expo-router';

import { clearSharedFootprintDraft } from '@/src/features/daily/footprints/share/sharedFootprintDraft';

import { FootprintEditorScreen } from '@/src/features/daily/footprints';

function parseFootprintId(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw || null;
}

export default function FootprintEditRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; shareDraft?: string }>();

  return (
    <FootprintEditorScreen
      key={params.shareDraft || params.id || 'new'}
      sharedDraftId={params.shareDraft}
      footprintId={parseFootprintId(params.id)}
      onBack={() => {
        if (params.shareDraft) void clearSharedFootprintDraft(params.shareDraft).catch(() => undefined);
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
