import { defaultValueCtx, Editor, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { gfm } from "@milkdown/kit/preset/gfm";
import "prosemirror-view/style/prosemirror.css";
import { useNoteContent, useAutoSave } from "../../api";
import { NoteContent } from "../../api/hooks";
import "./MdEditor.css";

const AUTOSAVE_DELAY = 400;

function MdEditor({ path, content }: { path: string; content: NoteContent }) {
  const [pathSignal, _] = createSignal(path);

  const autoSave = useAutoSave({
    getPath: pathSignal,
    getContent: content.content,
    delay: AUTOSAVE_DELAY,
  });

  // Set initial content as last saved to avoid triggering autosave on load
  autoSave.setLastSavedContent(content.content());

  let ref: HTMLDivElement | null = null;
  let editor: Editor;

  onMount(async () => {
    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, ref);
        ctx.set(defaultValueCtx, content.content() || "");
        ctx
          .get(listenerCtx)
          .markdownUpdated((_ctx, markdown, _prevMarkdown) => {
            content.setContent(markdown);
            let processedMarkdown = markdown;
            autoSave.scheduleAutoSave(processedMarkdown);
          });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .create();
  });

  onCleanup(() => {
    editor.destroy();
  });

  return (
    <>
      <div ref={ref!} class="flex w-full flex-col" />

      {/*<div class="text-text-muted pointer-events-none fixed bottom-2 left-2 text-xs opacity-40">
        {(autoSave.isSaving() && "Saving...") ||
          (autoSave.hasUnsavedChanges() && "Unsaved changes")}
      </div>*/}
    </>
  );
}

function MdLoader({ path }: { path: string }) {
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
        <MdEditor path={path} content={content} />
      </Show>
    </>
  );
}

export default MdLoader;
