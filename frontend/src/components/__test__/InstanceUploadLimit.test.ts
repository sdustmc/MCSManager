// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import InstanceUploadLimit from "../InstanceUploadLimit.vue";

vi.mock("@/lang/i18n", () => ({
  t: (key: string, params?: { limit: number }) => (params ? `${key}:${params.limit}` : key)
}));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const wrappers: VueWrapper[] = [];
const editor = (value = 0, shared = true, sharedValue = 0) => {
  const wrapper = mount(InstanceUploadLimit, { props: { value, shared, sharedValue } });
  wrappers.push(wrapper);
  return wrapper;
};

const boundEditor = (initialValue = 0, sharedInitially = false, sharedLimit = 0) => {
  const value = ref(initialValue);
  const shared = ref(sharedInitially);
  const sharedValue = ref(sharedLimit);
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h(InstanceUploadLimit, {
          value: value.value,
          shared: shared.value,
          sharedValue: sharedValue.value,
          "onUpdate:value": (updated: number) => {
            value.value = updated;
          },
          "onUpdate:sharedValue": (updated: number) => {
            sharedValue.value = updated;
          }
        })
    })
  );
  wrappers.push(wrapper);
  return { wrapper, value, shared, sharedValue };
};

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe("instance upload limit editor", () => {
  it("keeps nonshared instances in KB/s", async () => {
    const wrapper = editor(1024, false);
    expect(wrapper.text()).toContain("TXT_CODE_network_upload_limit");
    expect(wrapper.text()).toContain("KB/s");
    expect(wrapper.get("input").element.value).toBe("1024");
    await wrapper.get("input").setValue("2560");
    expect(wrapper.emitted("update:value")?.at(-1)).toEqual([2560]);
    expect(wrapper.props("value")).toBe(1024);
  });

  it.each([
    ["100.5", 100.5],
    [".5", 0.5]
  ])(
    "preserves %s when typed character by character with parent updates",
    async (text, expected) => {
      const { wrapper, value } = boundEditor();
      const input = wrapper.get("input");
      await input.setValue(text[0]);
      for (const character of text.slice(1)) {
        await input.setValue(input.element.value + character);
      }
      expect(value.value).toBe(expected);
      await input.trigger("blur");
      expect(Number(input.element.value)).toBe(expected);
    }
  );

  it("allows clearing and replacing a nonshared limit with parent updates", async () => {
    const { wrapper, value } = boundEditor(1024);
    const input = wrapper.get("input");
    await input.setValue("");
    expect(input.element.value).toBe("");
    expect(value.value).toBe(0);
    await input.setValue("256");
    expect(input.element.value).toBe("256");
    expect(value.value).toBe(256);
  });

  it.each([
    [10, 1250],
    [20, 2500],
    [0.001, 0.125]
  ])(
    "saves %s dedicated Mbps as %s KB/s without changing shared bandwidth",
    async (mbps, kilobytes) => {
      const wrapper = editor();
      expect(wrapper.text()).toContain("TXT_CODE_DEDICATED_INSTANCE_CAP");
      expect(wrapper.text()).toContain("Mbps");
      await wrapper.get("input").setValue(String(mbps));
      expect(wrapper.emitted("update:value")?.at(-1)).toEqual([kilobytes]);
      expect(wrapper.props("value")).toBe(0);
      expect(wrapper.emitted("update:sharedValue")).toBeUndefined();
    }
  );

  it("preserves and refreshes the stored limit when toggling shared mode", async () => {
    const wrapper = editor(1024, false);
    await wrapper.setProps({ shared: true });
    expect(wrapper.get("input").element.value).toBe("8.192");
    await wrapper.setProps({ shared: false });
    expect(wrapper.get("input").element.value).toBe("1024");
    await wrapper.setProps({ shared: true, value: 2500 });
    expect(Number(wrapper.get("input").element.value)).toBe(20);
    await wrapper.setProps({ shared: false });
    expect(wrapper.get("input").element.value).toBe("2500");
    expect(wrapper.emitted("update:value")).toBeUndefined();
  });

  it("removes only the per-instance ceiling when the shared input is cleared", async () => {
    const wrapper = editor(1250, true, 1250);
    await wrapper.findAll("input")[1].setValue("");
    expect(wrapper.emitted("update:sharedValue")?.at(-1)).toEqual([0]);
    expect(wrapper.emitted("update:value")).toBeUndefined();
    expect(wrapper.props("value")).toBe(1250);
    expect(wrapper.props("shared")).toBe(true);
  });

  it("accepts a shared value after shared bandwidth is enabled", async () => {
    const wrapper = editor(0, false);
    await wrapper.setProps({ shared: true });
    await wrapper.findAll("input")[1].setValue("10");
    expect(wrapper.emitted("update:sharedValue")?.at(-1)).toEqual([1250]);
    expect(wrapper.emitted("update:value")).toBeUndefined();
  });

  it.each([
    [10, 1250],
    [20, 2500],
    [0.001, 0.125]
  ])("saves %s additional shared Mbps as %s KB/s", async (mbps, kilobytes) => {
    const { wrapper, value, sharedValue } = boundEditor(1250, true);
    await wrapper.findAll("input")[1].setValue(String(mbps));
    expect(sharedValue.value).toBe(kilobytes);
    expect(value.value).toBe(1250);
  });

  it("keeps 10 Mbps dedicated plus 10 Mbps shared independent across toggles and edits", async () => {
    const { wrapper, value, shared, sharedValue } = boundEditor(1250, false, 1250);
    expect(wrapper.get("input").element.value).toBe("1250");
    shared.value = true;
    await nextTick();
    expect(wrapper.findAll("input").map((input) => Number(input.element.value))).toEqual([10, 10]);
    expect(wrapper.text()).toContain("TXT_CODE_COMBINED_UPLOAD_CAP:20");
    await wrapper.findAll("input")[1].setValue("20");
    expect(sharedValue.value).toBe(2500);
    expect(value.value).toBe(1250);
    expect(wrapper.text()).toContain("TXT_CODE_COMBINED_UPLOAD_CAP:30");
    shared.value = false;
    await nextTick();
    expect(wrapper.get("input").element.value).toBe("1250");
    expect(sharedValue.value).toBe(2500);
    shared.value = true;
    await nextTick();
    expect(wrapper.findAll("input").map((input) => Number(input.element.value))).toEqual([10, 20]);
  });

  it("shows different limits for different instances", () => {
    expect(Number(editor(1250, true, 1250).findAll("input")[1].element.value)).toBe(10);
    expect(Number(editor(1250, true, 2500).findAll("input")[1].element.value)).toBe(20);
  });
});
