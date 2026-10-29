// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import InstanceUploadLimit from "../InstanceUploadLimit.vue";

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));

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
const editor = (value = 0, shared = true) => {
  const wrapper = mount(InstanceUploadLimit, { props: { value, shared } });
  wrappers.push(wrapper);
  return wrapper;
};

const boundEditor = (initialValue = 0) => {
  const value = ref(initialValue);
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h(InstanceUploadLimit, {
          value: value.value,
          shared: false,
          "onUpdate:value": (updated: number) => {
            value.value = updated;
          }
        })
    })
  );
  wrappers.push(wrapper);
  return { wrapper, value };
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
  ])("saves %s Mbps as %s KB/s for the existing API", async (mbps, kilobytes) => {
    const wrapper = editor();
    expect(wrapper.text()).toContain("TXT_CODE_SHARED_INSTANCE_CAP");
    expect(wrapper.text()).toContain("Mbps");
    await wrapper.get("input").setValue(String(mbps));
    expect(wrapper.emitted("update:value")?.at(-1)).toEqual([kilobytes]);
    expect(wrapper.props("value")).toBe(0);
  });

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
    const wrapper = editor(1250);
    await wrapper.get("input").setValue("");
    expect(wrapper.emitted("update:value")?.at(-1)).toEqual([0]);
    expect(wrapper.props("shared")).toBe(true);
  });

  it("accepts a shared value after shared bandwidth is enabled", async () => {
    const wrapper = editor(0, false);
    await wrapper.setProps({ shared: true });
    await wrapper.get("input").setValue("10");
    expect(wrapper.emitted("update:value")?.at(-1)).toEqual([1250]);
  });

  it("shows different limits for different instances", () => {
    expect(Number(editor(1250).get("input").element.value)).toBe(10);
    expect(Number(editor(2500).get("input").element.value)).toBe(20);
  });
});
