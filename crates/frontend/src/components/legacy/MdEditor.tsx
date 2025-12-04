import { defaultValueCtx, Editor, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { gfm } from "@milkdown/kit/preset/gfm";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { convertFileSrc } from "@tauri-apps/api/core";
import "prosemirror-view/style/prosemirror.css";
import { useNoteContent, useAutoSave } from "../../api";
import { NoteContent } from "../../api/hooks";
import { commands } from "../../api/commands";
import "./MdEditor.css";

const AUTOSAVE_DELAY = 400;

/**
 * Create a Milkdown plugin that resolves image paths for display
 */
const createImagePathResolverPlugin = (notePath: string) => {
  const pluginKey = new PluginKey("imagePathResolver");

  return $prose(() => {
    return new Plugin({
      key: pluginKey,
      props: {
        decorations(state) {
          state.doc.descendants((node, _pos) => {
            if (node.type.name === "image") {
              const src = node.attrs.src;

              // Only process local paths (relative paths starting with ./ or _attachments/)
              if (
                src &&
                !src.startsWith("http") &&
                !src.startsWith("asset://")
              ) {
                // Resolve the path asynchronously and update the DOM
                (async () => {
                  try {
                    const fullPath = await commands.resolveImagePath(
                      notePath,
                      src,
                    );
                    const assetUrl = convertFileSrc(fullPath, "asset");

                    // Find the image element in the DOM and update its src
                    const images = document.querySelectorAll(
                      `img[src="${src}"]`,
                    );
                    images.forEach((img) => {
                      if (img instanceof HTMLImageElement) {
                        img.src = assetUrl;
                      }
                    });
                  } catch (error) {
                    console.error(
                      `Failed to resolve image path: ${src}`,
                      error,
                    );
                  }
                })();
              }
            }
          });

          return null;
        },
      },
    });
  });
};

/**
 * Create a Milkdown plugin that handles pasting image URLs
 */
const createImagePastePlugin = (notePath: string) => {
  const pluginKey = new PluginKey("imagePaste");

  return $prose(() => {
    return new Plugin({
      key: pluginKey,
      props: {
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData("text/plain");
          const html = event.clipboardData?.getData("text/html");

          if (!text && !html) return false;

          // Extract image URLs from HTML img tags (e.g., from Pinterest)
          if (html) {
            const htmlImageRegex =
              /<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi;
            const htmlMatches = Array.from(html.matchAll(htmlImageRegex));

            if (htmlMatches.length > 0) {
              // Check if any of the images are remote URLs
              const remoteImages = htmlMatches.filter((match) => {
                const url = match[1];
                return url.startsWith("http://") || url.startsWith("https://");
              });

              if (remoteImages.length > 0) {
                event.preventDefault();
                console.log(
                  "Detected HTML images with remote URLs:",
                  remoteImages.length,
                );

                // Process all remote images
                const imagePromises = remoteImages.map(async (match) => {
                  const url = match[1];
                  const alt = match[2] || "image";

                  console.log("Downloading image:", url);
                  try {
                    const localPath = await commands.downloadImage(
                      notePath,
                      url,
                    );
                    console.log("Downloaded to:", localPath);
                    return { alt, localPath };
                  } catch (error) {
                    console.error("Failed to download image:", error);
                    return null;
                  }
                });

                // Wait for all downloads and insert images
                Promise.all(imagePromises).then((results) => {
                  const { tr } = view.state;
                  const { schema } = view.state;
                  let { from } = view.state.selection;

                  results.forEach((result) => {
                    if (result) {
                      const imageNode = schema.nodes.image?.create({
                        src: result.localPath,
                        alt: result.alt,
                      });

                      if (imageNode) {
                        tr.replaceWith(from, from, imageNode);
                        from = from + 1; // Move position forward for next image
                      }
                    }
                  });

                  view.dispatch(tr);
                });

                return true;
              }
            }
          }

          // Extract image URLs from markdown image syntax
          // Matches: ![alt](url) or ![alt](url "title")
          if (text) {
            const markdownImageRegex =
              /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
            const matches = Array.from(text.matchAll(markdownImageRegex));

            if (matches.length > 0) {
              // Check if any of the images are remote URLs
              const remoteImages = matches.filter((match) => {
                const url = match[2];
                return url.startsWith("http://") || url.startsWith("https://");
              });

              if (remoteImages.length > 0) {
                event.preventDefault();
                console.log(
                  "Detected markdown images with remote URLs:",
                  remoteImages.length,
                );

                // Process all remote images
                const imagePromises = remoteImages.map(async (match) => {
                  const alt = match[1] || "image";
                  const url = match[2];

                  console.log("Downloading image:", url);
                  try {
                    const localPath = await commands.downloadImage(
                      notePath,
                      url,
                    );
                    console.log("Downloaded to:", localPath);
                    return { alt, localPath };
                  } catch (error) {
                    console.error("Failed to download image:", error);
                    return null;
                  }
                });

                // Wait for all downloads and insert images
                Promise.all(imagePromises).then((results) => {
                  const { tr } = view.state;
                  const { schema } = view.state;
                  let { from } = view.state.selection;

                  results.forEach((result) => {
                    if (result) {
                      const imageNode = schema.nodes.image?.create({
                        src: result.localPath,
                        alt: result.alt,
                      });

                      if (imageNode) {
                        tr.replaceWith(from, from, imageNode);
                        from = from + 1; // Move position forward for next image
                      }
                    }
                  });

                  view.dispatch(tr);
                });

                return true;
              }
            }
          }

          // Check if the pasted text is a plain image URL
          if (text) {
            const imageUrlRegex =
              /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i;
            const isImageUrl = imageUrlRegex.test(text.trim());

            if (isImageUrl) {
              event.preventDefault();

              console.log("Detected image URL paste:", text.trim());
              console.log("Note path:", notePath);

              // Download the image asynchronously
              commands
                .downloadImage(notePath, text.trim())
                .then((localPath) => {
                  console.log("Image downloaded successfully to:", localPath);

                  // Get the image node type from the schema
                  const { schema } = view.state;
                  const imageNode = schema.nodes.image?.create({
                    src: localPath,
                    alt: "image",
                  });

                  if (imageNode) {
                    // Insert as a proper image node
                    const { tr } = view.state;
                    const { from } = view.state.selection;
                    tr.replaceWith(from, from, imageNode);
                    view.dispatch(tr);
                  }
                })
                .catch((error) => {
                  console.error("Failed to download image:", error);
                  // Fall back to inserting the URL as-is
                  const { tr } = view.state;
                  const { from } = view.state.selection;
                  tr.insertText(text, from);
                  view.dispatch(tr);
                });

              return true;
            }
          }

          return false;
        },
      },
    });
  });
};

/**
 * Create a plugin to handle checkbox clicks
 */
const createCheckboxClickPlugin = () => {
  const pluginKey = new PluginKey("checkboxClick");

  return $prose(() => {
    return new Plugin({
      key: pluginKey,
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            // Only handle left clicks
            if (event.button !== 0) return false;

            const target = event.target as HTMLElement;
            const listItem = target.closest("li[data-checked]");
            if (!listItem) return false;

            const rect = listItem.getBoundingClientRect();
            const clickX = event.clientX - rect.left;

            // Only handle clicks in the checkbox area (left 32px)
            if (clickX > 32) return false;

            event.preventDefault();
            event.stopPropagation();

            // Find the list_item node position
            let pos = view.posAtDOM(listItem, 0);
            let node = view.state.doc.nodeAt(pos);

            // If we got a paragraph, move up to find the list_item
            if (node?.type.name === "paragraph") {
              const $pos = view.state.doc.resolve(pos);
              // Go up one level to the parent
              if ($pos.depth > 0) {
                pos = $pos.before($pos.depth);
                node = view.state.doc.nodeAt(pos);
              }
            }

            if (
              node &&
              (node.type.name === "task_list_item" ||
                node.type.name === "list_item")
            ) {
              const { tr } = view.state;
              const currentChecked =
                listItem.getAttribute("data-checked") === "true";
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                checked: !currentChecked,
              });
              view.dispatch(tr);
              return true;
            }

            return false;
          },
        },
      },
    });
  });
};

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
      .use(createImagePathResolverPlugin(path))
      .use(createImagePastePlugin(path))
      .use(createCheckboxClickPlugin())
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
