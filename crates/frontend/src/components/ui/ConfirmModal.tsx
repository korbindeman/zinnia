import { createEffect, onCleanup } from "solid-js";

export function ConfirmModal(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  let dialogRef: HTMLDialogElement | undefined;
  let confirmRef: HTMLButtonElement | undefined;

  createEffect(() => {
    if (props.open) {
      dialogRef?.showModal();
      setTimeout(() => confirmRef?.focus(), 0);
    } else {
      dialogRef?.close();
    }
  });

  const handleConfirm = () => {
    props.onConfirm();
    props.onClose();
  };

  const handleCancel = () => {
    props.onClose();
  };

  const handleDialogClick = (e: MouseEvent) => {
    if (e.target === dialogRef) {
      props.onClose();
    }
  };

  onCleanup(() => {
    dialogRef?.close();
  });

  return (
    <dialog
      ref={dialogRef}
      class="bg-button-bg fixed top-1/2 left-1/2 w-[300px] -translate-x-1/2 -translate-y-1/2 rounded border p-4 backdrop:bg-black/50"
      style={{ "z-index": "9999" }}
      onClick={handleDialogClick}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div class="text-text mb-3 text-sm font-medium">{props.title}</div>
      <div class="text-text-muted mb-4 text-xs">{props.message}</div>
      <div class="flex justify-end gap-2">
        <button
          class="text-text-muted px-3 py-1 text-xs hover:underline"
          onClick={handleCancel}
        >
          {props.cancelLabel || "Cancel"}
        </button>
        <button
          ref={confirmRef}
          class="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
          onClick={handleConfirm}
        >
          {props.confirmLabel || "Confirm"}
        </button>
      </div>
    </dialog>
  );
}
