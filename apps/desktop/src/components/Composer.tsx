import { useCallback, useRef, useState } from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  ShieldIcon,
  StopIcon,
} from "./Icons";

export interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  content: string;
}

interface ComposerProps {
  onSend: (message: string, attachments: ComposerAttachment[]) => void | Promise<void>;
  disabled: boolean;
  isProcessing?: boolean;
  onAbort?: () => void;
  modelName?: string;
  onOpenSettings?: () => void;
}

const MAX_ATTACHMENTS = 4;
const MAX_FILE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "py",
  "rs",
  "toml",
  "yaml",
  "yml",
  "sh",
  "sql",
  "xml",
  "csv",
]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function canReadAsText(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    file.type.startsWith("text/") || file.type.includes("json") || TEXT_EXTENSIONS.has(extension)
  );
}

export function Composer({
  onSend,
  disabled,
  isProcessing = false,
  onAbort,
  modelName = "Gear",
  onOpenSettings,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resizeTextarea = useCallback((element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, []);

  const handleSubmit = useCallback(() => {
    const message = value.trim();
    if ((!message && attachments.length === 0) || disabled) return;
    void onSend(message || "Please review the attached file.", attachments);
    setValue("");
    setAttachments([]);
    setAttachmentError("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [attachments, disabled, onSend, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = [...(event.target.files ?? [])];
      event.target.value = "";
      if (selectedFiles.length === 0) return;

      const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      const accepted: ComposerAttachment[] = [];
      let error =
        selectedFiles.length > slots ? `You can attach up to ${MAX_ATTACHMENTS} files.` : "";

      for (const file of selectedFiles.slice(0, slots)) {
        if (file.size > MAX_FILE_BYTES) {
          error = `${file.name} is larger than 512 KB.`;
          continue;
        }
        if (!canReadAsText(file)) {
          error = `${file.name} is not a supported text or code file.`;
          continue;
        }
        accepted.push({
          id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          size: file.size,
          type: file.type || "text/plain",
          content: await file.text(),
        });
      }

      setAttachments((current) => [...current, ...accepted]);
      setAttachmentError(error);
    },
    [attachments.length],
  );

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="composer-area">
      <div className={`composer ${focused ? "composer--focused" : ""}`}>
        {attachments.length > 0 ? (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.id}>
                <PaperclipIcon />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{formatBytes(attachment.size)}</small>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                  }
                  aria-label={`Remove ${attachment.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            resizeTextarea(event.target);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={
            isProcessing ? "Gear is working…" : "Ask Gear to build, explain, or investigate"
          }
          rows={1}
          disabled={disabled}
          aria-label="Message Gear"
        />

        <div className="composer-toolbar">
          <div className="composer-tools">
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              multiple
              accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.rs,.toml,.yaml,.yml,.sh,.sql,.xml,.csv,text/*,application/json"
              onChange={handleFiles}
              tabIndex={-1}
            />
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach text or code files"
              aria-label="Attach files"
            >
              <PlusIcon />
            </button>
            <span className="composer-access" title="Tools ask before sensitive actions">
              <ShieldIcon />
              Permissioned
            </span>
          </div>

          <div className="composer-actions">
            <button
              type="button"
              className="composer-model"
              onClick={onOpenSettings}
              title="Change model"
            >
              <span>{modelName}</span>
              <ChevronDownIcon />
            </button>
            <button
              type="button"
              className="composer-icon-button composer-mic"
              disabled
              title="Voice input is not available yet"
              aria-label="Voice input unavailable"
            >
              <MicIcon />
            </button>
            {isProcessing && onAbort ? (
              <button
                type="button"
                className="send-button send-button--stop"
                onClick={onAbort}
                title="Stop Gear"
                aria-label="Stop generation"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                onClick={handleSubmit}
                disabled={!canSend}
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-caption">
        <span className={attachmentError ? "composer-error" : ""}>
          {attachmentError || "Enter to send · Shift+Enter for a new line"}
        </span>
        <span>Gear can make mistakes. Review changes before shipping.</span>
      </div>
    </div>
  );
}
