import { createSignal, onMount, Show, For } from "solid-js";
import { Modal } from "../primitives/Modal";
import { Card } from "../primitives/Card";
import { NumberInput, Checkbox } from "../primitives/form";
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type Settings as SettingsType,
} from "../../utils/settings";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

type SettingConfig =
  | {
      type: "number";
      key: keyof SettingsType;
      label: string;
      min: number;
      max: number;
      step: number;
      onUpdate?: (value: number, settings: SettingsType) => void;
    }
  | {
      type: "boolean";
      key: keyof SettingsType;
      label: string;
    }
  | {
      type: "info";
      label: string;
      getValue: () => string;
      action?: { label: string; onClick: () => void };
    }
  | {
      type: "separator";
    };

function SettingRow(props: {
  label?: string;
  labelSuffix?: string;
  showReset?: boolean;
  onReset?: () => void;
  children: any;
}) {
  return (
    <div class="flex items-center justify-between">
      <Show
        when={props.label}
        fallback={<div class="flex items-baseline gap-1">{props.children}</div>}
      >
        <label>{props.label}</label>
        <div class="flex items-center gap-2">
          <Show when={props.showReset && props.onReset}>
            <button
              type="button"
              onClick={props.onReset}
              class="text-text-muted hover:text-text text-xs hover:underline"
            >
              Reset
            </button>
          </Show>
          {props.children}
        </div>
      </Show>
    </div>
  );
}

export function Settings(props: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = createSignal<SettingsType | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [version, setVersion] = createSignal<string>("");

  onMount(async () => {
    const loaded = await loadSettings();
    setSettings(loaded);
    const appVersion = await getVersion();
    setVersion(appVersion);
    setLoading(false);
  });

  const updateSetting = async <K extends keyof SettingsType>(
    key: K,
    value: SettingsType[K],
    onUpdate?: (value: any, settings: SettingsType) => void,
  ) => {
    const current = settings();
    if (!current) return;
    const updated = { ...current, [key]: value };
    setSettings(updated);
    if (onUpdate) {
      onUpdate(value, updated);
    }
    await saveSettings(updated);
  };

  const settingsConfig: SettingConfig[] = [
    {
      type: "number",
      key: "fontSize",
      label: "Font Size",
      min: 10,
      max: 32,
      step: 1,
      onUpdate: (value: number) => {
        document.documentElement.style.setProperty("--text-base", `${value}px`);
      },
    },
    { type: "separator" },
    {
      type: "boolean",
      key: "openLastNote",
      label: "Open last viewed note on startup",
    },
    { type: "separator" },
    {
      type: "info",
      label: "Version",
      getValue: () => version(),
      action: {
        label: "Release Notes",
        onClick: () =>
          openUrl("https://github.com/korbindeman/zinnia/releases"),
      },
    },
    {
      type: "boolean",
      key: "autoCheckUpdates",
      label: "Automatically check for updates",
    },
  ];

  const renderSetting = (config: SettingConfig) => {
    const current = settings();
    if (!current) return null;

    if (config.type === "separator") {
      return <hr />;
    }

    if (config.type === "info") {
      return (
        <div class="flex items-center justify-between">
          <div class="flex items-baseline gap-1">
            <label>{config.label}</label>
            <span class="text-text-muted/60 text-xs">v{config.getValue()}</span>
          </div>
          <Show when={config.action}>
            <button
              type="button"
              onClick={config.action!.onClick}
              class="text-text-muted hover:text-text text-xs hover:underline"
            >
              {config.action!.label}
            </button>
          </Show>
        </div>
      );
    }

    if (config.type === "number") {
      const value = current[config.key] as number;
      const defaultValue = DEFAULT_SETTINGS[config.key] as number;
      const hasChanged = value !== defaultValue;

      return (
        <SettingRow
          label={config.label}
          showReset={hasChanged}
          onReset={() =>
            updateSetting(config.key, defaultValue, config.onUpdate)
          }
        >
          <NumberInput
            value={value}
            onChange={(newValue) =>
              updateSetting(config.key, newValue, config.onUpdate)
            }
            min={config.min}
            max={config.max}
            step={config.step}
          />
        </SettingRow>
      );
    }

    if (config.type === "boolean") {
      const value = current[config.key] as boolean;
      const defaultValue = DEFAULT_SETTINGS[config.key] as boolean;
      const hasChanged = value !== defaultValue;

      return (
        <SettingRow
          label={config.label}
          showReset={hasChanged}
          onReset={() => updateSetting(config.key, defaultValue)}
        >
          <Checkbox
            checked={value}
            onChange={(newValue) => updateSetting(config.key, newValue)}
          />
        </SettingRow>
      );
    }

    return null;
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <Card class="w-[400px] px-4 py-4 pb-8">
        <Show when={!loading() && settings()}>
          <div class="space-y-4">
            <h1 class="text-text pb-1">Settings</h1>
            <For each={settingsConfig}>{(config) => renderSetting(config)}</For>
          </div>
        </Show>

        <Show when={loading()}>
          <div class="text-text-muted">Loading settings...</div>
        </Show>
      </Card>
    </Modal>
  );
}
