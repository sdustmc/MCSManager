<script setup lang="ts">
import { useStoragePools } from "@/hooks/useStoragePools";
import { useStorageQuotaOperation } from "@/hooks/useStorageQuotaOperation";
import { t } from "@/lang/i18n";
import { checkStorageQuotaApi, retryStorageQuotaApi } from "@/services/apis/storageQuota";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import { computed, onUnmounted, ref, toRef, watch } from "vue";
import StorageQuotaStatus from "./StorageQuotaStatus.vue";

const props = defineProps<{
  value: IGlobalInstanceDockerConfig;
  daemonId?: string;
  instanceId?: string;
  cwd?: string;
  processType?: ProcessType;
  quota?: IStorageQuotaInfo;
  templateMode?: boolean;
}>();
const emit = defineEmits<{ (event: "update:value", value: IGlobalInstanceDockerConfig): void }>();
const { isAdmin } = useAppStateStore();
const { pools, error, loading, refresh } = useStoragePools(toRef(props, "daemonId"));
const update = (field: keyof IGlobalInstanceDockerConfig, value: unknown) =>
  emit("update:value", { ...props.value, [field]: value });
const hardGiB = computed(
  () =>
    Math.ceil(
      (Number(props.value.maxSpace || 0) *
        1024 *
        1024 *
        (100 + Number(props.value.storageQuotaBufferPercent ?? 10))) /
        100
    ) /
    (1024 * 1024)
);
const recovery = useStorageQuotaOperation();
const currentQuota = computed(() => recovery.quota.value ?? props.quota);
const checking = ref(false);
const checkResult = ref("");
let checkController: AbortController | undefined;
onUnmounted(() => checkController?.abort());
watch(
  () => props.value,
  () => {
    checkResult.value = "";
  },
  { deep: true }
);
watch(
  () => props.quota,
  () => {
    if (!recovery.running.value) recovery.quota.value = undefined;
  }
);
const check = async () => {
  if (!props.daemonId || !props.instanceId) return;
  checking.value = true;
  checkResult.value = "";
  checkController?.abort();
  checkController = new AbortController();
  try {
    await checkStorageQuotaApi().execute({
      params: { daemonId: props.daemonId, uuid: props.instanceId },
      data: { docker: props.value, cwd: props.cwd, processType: props.processType },
      signal: checkController.signal
    });
    checkResult.value = t("TXT_CODE_QUOTA_CHECK_OK");
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    checking.value = false;
  }
};
const retry = async () => {
  if (!props.daemonId || !props.instanceId) return;
  checking.value = true;
  try {
    await retryStorageQuotaApi().execute({
      params: { daemonId: props.daemonId, uuid: props.instanceId }
    });
    await recovery.wait(props.daemonId, props.instanceId);
    checkResult.value = "";
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    checking.value = false;
  }
};
</script>

<template>
  <a-row :gutter="[16, 8]">
    <a-col :xs="24" :lg="8">
      <a-form-item :label="t('TXT_CODE_QUOTA_ALLOCATION')">
        <a-input-number
          :value="Number(value.maxSpace || 0)"
          :min="0"
          :max="1048576"
          addon-after="GiB"
          style="width: 100%"
          @change="update('maxSpace', Number($event || 0))"
        />
      </a-form-item>
    </a-col>
    <a-col :xs="24" :lg="8">
      <a-form-item :label="t('TXT_CODE_storage_quota_hard_limit')">
        <a-switch
          :checked="Boolean(value.enableHardStorageQuota)"
          :disabled="processType !== 'docker'"
          @change="update('enableHardStorageQuota', $event)"
        />
      </a-form-item>
    </a-col>
    <template v-if="value.enableHardStorageQuota">
      <a-col :xs="24" :lg="8">
        <a-form-item :label="t('TXT_CODE_QUOTA_BUFFER')">
          <a-input-number
            :value="value.storageQuotaBufferPercent ?? 10"
            :min="0"
            :max="100"
            addon-after="%"
            style="width: 100%"
            @change="update('storageQuotaBufferPercent', Number($event || 0))"
          />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :lg="12">
        <a-form-item :label="t('TXT_CODE_QUOTA_FILES_LIMIT')">
          <a-input-number
            :value="value.storageQuotaInodes ?? 0"
            :min="0"
            :max="4294967295"
            :precision="0"
            style="width: 100%"
            @change="update('storageQuotaInodes', Number($event || 0))"
          />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :lg="12">
        <a-form-item :label="t('TXT_CODE_QUOTA_WARNING_PERCENT')">
          <a-input-number
            :value="value.storageQuotaWarningPercent ?? 80"
            :min="1"
            :max="100"
            addon-after="%"
            style="width: 100%"
            @change="update('storageQuotaWarningPercent', Number($event || 80))"
          />
        </a-form-item>
      </a-col>
      <a-col :span="24">
        <a-alert
          v-if="isAdmin"
          type="info"
          show-icon
          :message="t('TXT_CODE_QUOTA_EFFECTIVE_LIMIT', { size: hardGiB.toFixed(2) })"
          :description="t('TXT_CODE_QUOTA_BUFFER_HELP')"
        />
        <a-alert
          v-else
          type="info"
          show-icon
          :description="t('TXT_CODE_QUOTA_BUFFER_HELP')"
        />
      </a-col>
    </template>
    <a-col v-if="!templateMode" :span="24">
      <a-form-item :label="t('TXT_CODE_QUOTA_POOL')">
        <a-space direction="vertical" align="start" size="small" style="width: 100%">
          <a-space wrap>
            <a-select
              :value="value.storagePoolId || undefined"
              :loading="loading"
              allow-clear
              style="min-width: 240px"
              :placeholder="t('TXT_CODE_QUOTA_DEFAULT_PATH')"
              @change="update('storagePoolId', $event || '')"
            >
              <a-select-option
                v-for="pool in pools"
                :key="pool.id"
                :value="pool.id"
                :disabled="Boolean(pool.error)"
                >{{ pool.name }}</a-select-option
              >
            </a-select>
            <a-button :loading="loading" @click="refresh">{{ t("TXT_CODE_b76d94e0") }}</a-button>
          </a-space>
          <div style="width: 100%">
            <a-typography-text type="secondary">
              {{ t("TXT_CODE_QUOTA_POOL_MOVE") }}
            </a-typography-text>
          </div>
          <a-alert
            v-if="error"
            :message="error"
            type="warning"
            show-icon
            style="width: 100%"
          />
        </a-space>
      </a-form-item>
    </a-col>
    <a-col
      v-if="instanceId && (value.enableHardStorageQuota || currentQuota?.state === 'error')"
      :span="24"
    >
      <a-space wrap>
        <a-button v-if="value.enableHardStorageQuota" :loading="checking" @click="check">{{
          t("TXT_CODE_QUOTA_CHECK")
        }}</a-button>
        <a-button v-if="currentQuota?.state === 'error'" :loading="checking" @click="retry">{{
          t("TXT_CODE_QUOTA_RETRY")
        }}</a-button>
        <span v-if="checkResult">{{ checkResult }}</span>
      </a-space>
    </a-col>
    <a-col :span="24"><StorageQuotaStatus :quota="currentQuota" /></a-col>
  </a-row>
</template>
