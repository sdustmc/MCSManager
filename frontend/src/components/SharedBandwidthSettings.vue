<script setup lang="ts">
import { t } from "@/lang/i18n";

const props = defineProps<{ value: ISharedBandwidthConfig }>();
const emit = defineEmits<{ "update:value": [value: ISharedBandwidthConfig] }>();
const update = (patch: Partial<ISharedBandwidthConfig>) =>
  emit("update:value", { ...props.value, ...patch });
</script>

<template>
  <a-form layout="vertical">
    <a-alert
      type="info"
      show-icon
      :message="t('TXT_CODE_SHARED_HELP')"
      style="margin-bottom: 16px"
    />
    <a-form-item :label="t('TXT_CODE_SHARED_ENABLED')">
      <a-switch :checked="value.enabled" @change="update({ enabled: Boolean($event) })" />
    </a-form-item>
    <template v-if="value.enabled">
      <a-form-item :label="t('TXT_CODE_SHARED_INTERFACE')">
        <a-input
          :value="value.interface"
          :maxlength="15"
          :placeholder="t('TXT_CODE_SHARED_INTERFACE_PLACEHOLDER')"
          @update:value="update({ interface: $event })"
        />
      </a-form-item>
      <a-form-item :label="t('TXT_CODE_SHARED_UPLINK')">
        <a-typography-paragraph type="secondary">
          {{ t("TXT_CODE_SHARED_UPLINK_HELP") }}
        </a-typography-paragraph>
        <a-input-number
          :value="value.uplinkMbps"
          :min="1"
          :max="1000000"
          :precision="0"
          addon-after="Mbps"
          @change="update({ uplinkMbps: Number($event || 0) })"
        />
      </a-form-item>
      <a-form-item :label="t('TXT_CODE_SHARED_CAP')">
        <a-input-number
          :value="value.sharedMbps"
          :min="1"
          :max="value.uplinkMbps || 1000000"
          :precision="0"
          addon-after="Mbps"
          @change="update({ sharedMbps: Number($event || 0) })"
        />
      </a-form-item>
    </template>
  </a-form>
</template>
