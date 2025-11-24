import { createEffect, createSignal, For, Show } from "solid-js";
import { useNotes } from "../../api";
import CmLoader from "./CmLoader";

export default function EditorManager() {
  const notes = useNotes();

  const [activeEditors, setActiveEditors] = createSignal<string[]>([]);

  createEffect(async () => {
    const path = notes.currentPath();

    if (!path) return;

    if (activeEditors().includes(path)) return;

    setActiveEditors((prev) => [...prev, path]);
  });

  return (
    <>
      <Show when={activeEditors().length > 0} fallback={<></>}>
        <For each={activeEditors()}>
          {(item, _index) => (
            <Show when={item === notes.currentPath()}>
              <CmLoader path={item} />
            </Show>
          )}
        </For>
      </Show>
    </>
  );
}
