<script setup lang="ts">
import type { MountComponent } from "@/types";
import { t } from "@/lang/i18n";
import { updateInstanceConfig } from "@/services/apis/instance";
import { reportErrorMsg } from "@/tools/validator";
import { message } from "ant-design-vue";
import { ref } from "vue";

import AppConfigProvider from "../AppConfigProvider.vue";

interface Props extends MountComponent {
  instanceId: string;
  daemonId: string;
  remarks?: string;
}

const props = defineProps<Props>();

const open = ref(false);
const remarksValue = ref("");
const { execute, isLoading } = updateInstanceConfig();

let resolve: (remarks: string) => void;

const closeDialog = async (remarks: string) => {
  open.value = false;
  resolve(remarks);
  if (props.destroyComponent) props.destroyComponent(1000);
};

const cancel = async () => {
  await closeDialog(props.remarks || "");
};

const submit = async () => {
  try {
    const remarks = (remarksValue.value || "").slice(0, 500);
    await execute({
      params: {
        uuid: props.instanceId,
        daemonId: props.daemonId
      },
      data: {
        remarks
      }
    });
    message.success(t("TXT_CODE_a7907771"));
    await closeDialog(remarks);
  } catch (error) {
    reportErrorMsg(error);
  }
};

const openDialog = () => {
  remarksValue.value = props.remarks || "";
  open.value = true;
  return new Promise<string>((_resolve) => {
    resolve = _resolve;
  });
};

defineExpose({ openDialog });
</script>

<template>
  <AppConfigProvider>
    <a-modal
      v-model:open="open"
      centered
      :title="t('TXT_CODE_b8e8e6f5')"
      :confirm-loading="isLoading"
      :ok-text="t('TXT_CODE_d507abff')"
      @ok="submit"
      @cancel="cancel"
    >
      <a-textarea
        v-model:value="remarksValue"
        :placeholder="t('TXT_CODE_4ea93630')"
        :rows="4"
        :maxlength="500"
        show-count
      />
    </a-modal>
  </AppConfigProvider>
</template>
