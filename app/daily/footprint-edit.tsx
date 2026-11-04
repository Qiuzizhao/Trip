import { useLocalSearchParams, useRouter } from 'expo-router';

import { clearSharedFootprintDraft } from '@/src/features/daily/footprints/share/sharedFootprintDraft';
import { finishImagePicker } from '@/src/features/daily/footprints/imagePickerRecovery';

import { FootprintEditorScreen } from '@/src/features/daily/footprints';

function parseFootprintId(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw || null;
}

export default function FootprintEditRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; shareDraft?: string; recoveryDraft?: string }>();

  return (
    <FootprintEditorScreen
      key={params.recoveryDraft || params.shareDraft || params.id || 'new'}
      recoveryDraftId={params.recoveryDraft}
      sharedDraftId={params.shareDraft}
      footprintId={parseFootprintId(params.id)}
      onBack={() => {
        if (params.recoveryDraft) void finishImagePicker().catch(() => undefined);
        if (params.shareDraft) void clearSharedFootprintDraft(params.shareDraft).catch(() => undefined);
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
