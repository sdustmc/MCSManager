import { storagePoolsApi } from "@/services/apis/storageQuota";
import { onUnmounted, ref, watch, type Ref } from "vue";

export function useStoragePools(daemonId: Ref<string | undefined>) {
  const pools = ref<IStoragePoolInfo[]>([]);
  const error = ref("");
  const loading = ref(false);
  let generation = 0;
  let controller: AbortController | undefined;
  const refresh = async () => {
    controller?.abort();
    const current = ++generation;
    pools.value = [];
    error.value = "";
    loading.value = false;
    if (!daemonId.value) return;
    controller = new AbortController();
    loading.value = true;
    try {
      const result = await storagePoolsApi().execute({
        params: { daemonId: daemonId.value },
        forceRequest: true,
        signal: controller.signal
      });
      if (current === generation) pools.value = result.value || [];
    } catch (cause: any) {
      if (current === generation) error.value = String(cause?.message || cause);
    } finally {
      if (current === generation) loading.value = false;
    }
  };
  watch(daemonId, refresh, { immediate: true });
  onUnmounted(() => {
    generation++;
    controller?.abort();
  });
  return { pools, error, loading, refresh };
}
