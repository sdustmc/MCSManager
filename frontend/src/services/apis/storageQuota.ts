import { useDefineApi } from "@/stores/useDefineApi";

export const storagePoolsApi = useDefineApi<
  {
    params: { daemonId: string };
  },
  IStoragePoolInfo[]
>({
  url: "/api/service/storage_pools",
  timeout: 70000
});

export const checkStorageQuotaApi = useDefineApi<
  {
    params: { daemonId: string; uuid: string };
    data: Partial<IGlobalInstanceConfig>;
  },
  {
    available: boolean;
    workspace: string;
    mountPoint: string;
    allocatedBytes: number;
    hardLimitBytes: number;
  }
>({
  url: "/api/instance/storage_quota/check",
  method: "POST",
  timeout: 70000
});

export const retryStorageQuotaApi = useDefineApi<
  {
    params: { daemonId: string; uuid: string };
  },
  { storageQuotaStatus: "applying" }
>({
  url: "/api/instance/storage_quota/retry",
  method: "POST"
});
