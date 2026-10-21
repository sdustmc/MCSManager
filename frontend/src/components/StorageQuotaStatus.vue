<script setup lang="ts">
import { t } from "@/lang/i18n";
import { parseTimestamp } from "@/tools/time";
import prettyBytes from "pretty-bytes";
import { computed } from "vue";

const props = defineProps<{ quota?: IStorageQuotaInfo }>();
const format = (value?: number) =>
  value == null
    ? t("TXT_CODE_QUOTA_UNKNOWN")
    : prettyBytes(value, { binary: true, maximumFractionDigits: 2 });
const percent = computed(() =>
  props.quota?.allocatedBytes && props.quota.usedBytes != null
    ? Math.min(100, (props.quota.usedBytes / props.quota.allocatedBytes) * 100)
    : 0
);
const statusKeys = {
  disabled: "TXT_CODE_QUOTA_DISABLED",
  applying: "TXT_CODE_QUOTA_APPLYING",
  ready: "TXT_CODE_QUOTA_READY",
  error: "TXT_CODE_QUOTA_ERROR",
  unknown: "TXT_CODE_QUOTA_UNKNOWN"
};
</script>

<template>
  <div v-if="quota && quota.state !== 'disabled'" class="quota-status">
    <a-space wrap>
      <span>{{ t("TXT_CODE_DISK_USAGE") }}</span>
      <a-tag
        :color="
          quota.state === 'ready' ? 'green' : quota.state === 'applying' ? 'processing' : 'warning'
        "
      >
        {{ t(statusKeys[quota.state]) }}
      </a-tag>
      <span>{{ format(quota.usedBytes) }} / {{ format(quota.allocatedBytes) }}</span>
      <span v-if="quota.hardLimitBytes != null"
        >{{ t("TXT_CODE_QUOTA_HARD_CAP") }}: {{ format(quota.hardLimitBytes) }}</span
      >
    </a-space>
    <a-progress
      v-if="quota.usedBytes != null"
      :percent="Number(percent.toFixed(1))"
      :status="quota.warning ? 'exception' : 'normal'"
      size="small"
    />
    <div v-if="quota.hardLimitInodes">
      {{ t("TXT_CODE_QUOTA_FILES") }}: {{ quota.usedInodes ?? t("TXT_CODE_QUOTA_UNKNOWN") }} /
      {{ quota.hardLimitInodes }}
    </div>
    <div v-if="quota.updatedAt">
      {{ t("TXT_CODE_QUOTA_UPDATED_AT") }}: {{ parseTimestamp(quota.updatedAt) }}
    </div>
    <a-alert v-if="quota.error" :message="quota.error" type="warning" show-icon />
    <a-alert
      v-else-if="quota.warning"
      :message="t('TXT_CODE_QUOTA_WARNING')"
      type="warning"
      show-icon
    />
  </div>
</template>

<style scoped>
.quota-status {
  width: 100%;
  margin: 8px 0;
}
</style>
