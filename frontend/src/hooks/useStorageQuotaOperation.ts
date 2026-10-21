import { t } from "@/lang/i18n";
import { getInstanceInfo } from "@/services/apis/instance";
import { onUnmounted, ref } from "vue";

export function useStorageQuotaOperation() {
  const running = ref(false);
  const quota = ref<IStorageQuotaInfo>();
  let controller: AbortController | undefined;
  const cancel = () => controller?.abort();
  onUnmounted(cancel);

  const wait = async (daemonId: string, instanceId: string) => {
    cancel();
    const current = new AbortController();
    controller = current;
    running.value = true;
    quota.value = { state: "applying" };
    const deadline = Date.now() + 30 * 60 * 1000;
    try {
      while (!current.signal.aborted && Date.now() < deadline) {
        const result = await getInstanceInfo().execute({
          params: { daemonId, uuid: instanceId },
          forceRequest: true,
          signal: current.signal
        });
        quota.value = result.value?.info.storageQuota;
        if (quota.value?.state !== "applying") {
          if (!quota.value || quota.value.state === "error" || quota.value.state === "unknown")
            throw new Error(quota.value?.error || t("TXT_CODE_QUOTA_ERROR"));
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            current.signal.removeEventListener("abort", onAbort);
            reject(new Error(t("TXT_CODE_QUOTA_ERROR")));
          };
          const timer = setTimeout(() => {
            current.signal.removeEventListener("abort", onAbort);
            resolve();
          }, 1500);
          current.signal.addEventListener("abort", onAbort, { once: true });
          if (current.signal.aborted) onAbort();
        });
      }
      throw new Error(t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
    } finally {
      if (controller === current) {
        running.value = false;
        controller = undefined;
      }
    }
  };
  return { running, quota, wait, cancel };
}
