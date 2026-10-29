<script setup lang="ts">
import { t } from "@/lang/i18n";
import { computed, ref, watch } from "vue";

const props = defineProps<{ value?: number; shared?: boolean }>();
const emit = defineEmits<{ "update:value": [value: number] }>();

// Keep the existing API's KB/s value while displaying shared limits in Mbps.
const sharedMbps = computed(() => Number(props.value || 0) / 125);
const updateSharedMbps = (value: number | string | null) =>
  emit("update:value", Number((Number(value || 0) * 125).toFixed(3)));

// Keep an empty editor while the API stores it as zero (unlimited).
const nonsharedValue = ref<number | undefined>(props.value ?? 0);
watch(
  () => props.value,
  (value) => {
    if ((nonsharedValue.value ?? 0) !== (value ?? 0)) nonsharedValue.value = value ?? 0;
  }
);
const updateNonsharedValue = (value: number | string | null) => {
  nonsharedValue.value = value === null ? undefined : Number(value);
  emit("update:value", nonsharedValue.value ?? 0);
};
</script>

<template>
  <a-form-item>
    <a-typography-title :level="5">
      {{ t(shared ? "TXT_CODE_SHARED_INSTANCE_CAP" : "TXT_CODE_network_upload_limit") }}
    </a-typography-title>
    <a-typography-paragraph>
      <a-tooltip
        :title="
          t(shared ? 'TXT_CODE_SHARED_INSTANCE_CAP_HELP' : 'TXT_CODE_network_upload_limit_help')
        "
        placement="top"
      >
        <a-typography-text type="secondary" class="typography-text-ellipsis">
          {{
            t(shared ? "TXT_CODE_SHARED_INSTANCE_CAP_HELP" : "TXT_CODE_network_upload_limit_help")
          }}
        </a-typography-text>
      </a-tooltip>
    </a-typography-paragraph>
    <a-input-number
      v-if="shared"
      :value="sharedMbps"
      :min="0"
      :precision="3"
      :step="1"
      addon-after="Mbps"
      style="width: 100%"
      @change="updateSharedMbps"
    />
    <a-input-number
      v-else
      :value="nonsharedValue"
      :min="0"
      :placeholder="t('TXT_CODE_network_upload_limit_placeholder')"
      addon-after="KB/s"
      style="width: 100%"
      @change="updateNonsharedValue"
    />
  </a-form-item>
</template>
