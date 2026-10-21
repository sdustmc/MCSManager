<script setup lang="ts">
import { useStoragePools } from "@/hooks/useStoragePools";
import { t } from "@/lang/i18n";
import { getRandomId } from "@/tools/randId";
import prettyBytes from "pretty-bytes";
import { toRef } from "vue";

const props = defineProps<{ value: IStoragePoolConfig[]; daemonId?: string }>();
const emit = defineEmits<{ (event: "update:value", value: IStoragePoolConfig[]): void }>();
const { pools, error, loading, refresh } = useStoragePools(toRef(props, "daemonId"));
const update = (index: number, patch: Partial<IStoragePoolConfig>) =>
  emit(
    "update:value",
    props.value.map((pool, itemIndex) => (itemIndex === index ? { ...pool, ...patch } : pool))
  );
const add = () =>
  emit("update:value", [...props.value, { id: getRandomId(), name: "", path: "", reserveGiB: 10 }]);
const remove = (index: number) =>
  emit(
    "update:value",
    props.value.filter((_, itemIndex) => itemIndex !== index)
  );
const statistics = (id: string) => pools.value.find((pool) => pool.id === id);
const format = (value?: number) =>
  value == null
    ? t("TXT_CODE_QUOTA_UNKNOWN")
    : prettyBytes(value, { binary: true, maximumFractionDigits: 2 });
</script>

<template>
  <a-space direction="vertical" style="width: 100%" size="middle">
    <a-alert type="info" show-icon :message="t('TXT_CODE_QUOTA_POOLS_HELP')" />
    <a-alert v-if="error" type="warning" show-icon :message="error" />
    <a-card v-for="(pool, index) in value" :key="pool.id" size="small">
      <a-form layout="vertical">
        <a-form-item :label="t('TXT_CODE_QUOTA_POOL_NAME')"
          ><a-input
            :value="pool.name"
            :maxlength="80"
            @update:value="update(index, { name: $event })"
        /></a-form-item>
        <a-form-item :label="t('TXT_CODE_QUOTA_POOL_PATH_LABEL')"
          ><a-input :value="pool.path" @update:value="update(index, { path: $event })"
        /></a-form-item>
        <a-form-item :label="t('TXT_CODE_QUOTA_POOL_RESERVE')"
          ><a-input-number
            :value="pool.reserveGiB"
            :min="0"
            :max="1048576"
            addon-after="GiB"
            @change="update(index, { reserveGiB: Number($event || 0) })"
        /></a-form-item>
      </a-form>
      <a-descriptions size="small" :column="{ xs: 1, sm: 2 }">
        <a-descriptions-item :label="t('TXT_CODE_QUOTA_POOL_TOTAL')">{{
          format(statistics(pool.id)?.totalBytes)
        }}</a-descriptions-item>
        <a-descriptions-item :label="t('TXT_CODE_QUOTA_POOL_FREE')">{{
          format(statistics(pool.id)?.availableBytes)
        }}</a-descriptions-item>
        <a-descriptions-item :label="t('TXT_CODE_QUOTA_POOL_ALLOCATED')">{{
          format(statistics(pool.id)?.allocatedBytes)
        }}</a-descriptions-item>
        <a-descriptions-item :label="t('TXT_CODE_QUOTA_POOL_ALLOCATABLE')">{{
          format(statistics(pool.id)?.allocatableBytes)
        }}</a-descriptions-item>
      </a-descriptions>
      <a-alert
        v-if="statistics(pool.id)?.error"
        type="warning"
        show-icon
        :message="statistics(pool.id)?.error"
      />
      <a-button danger @click="remove(index)">{{ t("TXT_CODE_ecbd7449") }}</a-button>
    </a-card>
    <a-space>
      <a-button :disabled="value.length >= 32" @click="add">{{
        t("TXT_CODE_QUOTA_POOL_ADD")
      }}</a-button>
      <a-button :loading="loading" @click="refresh">{{ t("TXT_CODE_b76d94e0") }}</a-button>
    </a-space>
  </a-space>
</template>
