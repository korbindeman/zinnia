import { createSignal, createEffect, Show } from "solid-js";
import { useNoteContent } from "../../api/hooks";
import { CmEditor } from "./CmEditor";

function CmLoader({ path }: { path: string }) {
  const [pathSignal, _setPathSignal] = createSignal(path);

  const content = useNoteContent(pathSignal);

  const [readyForEditor, setReadyForEditor] = createSignal(false);

  createEffect(() => {
    if (!readyForEditor() && !content.isLoading()) {
      setReadyForEditor(true);
    }
  });

  return (
    <>
      <Show when={readyForEditor()}>
        <CmEditor path={path} content={content} />
      </Show>
    </>
  );
}

export default CmLoader;
