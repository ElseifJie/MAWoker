import { useRef, useState, type RefObject } from "react";
import { FileText } from "lucide-react";
import type { ArtifactSummary } from "../api.js";
import { Button, Dialog, EmptyState, Field, Input } from "../ui/index.js";

export interface MaterialPickerProps {
  open: boolean;
  files: readonly ArtifactSummary[];
  selectedIds: ReadonlySet<string>;
  onConfirm: (ids: Set<string>) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function MaterialPicker(props: MaterialPickerProps) {
  return props.open ? <MaterialPickerDialog {...props} /> : null;
}

function MaterialPickerDialog({
  files,
  selectedIds,
  onConfirm,
  onClose,
  returnFocusRef,
}: MaterialPickerProps) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState(() => new Set(selectedIds));
  const available = files.filter((file) => file.deletionState === "none");
  const query = search.trim().toLocaleLowerCase();
  const matches = available.filter((file) =>
    [file.name, file.id, file.sessionId].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    ),
  );

  return (
    <Dialog
      open
      title="选择已有文件"
      closeLabel="关闭材料选择"
      onClose={onClose}
      initialFocusRef={searchInput}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={
        <>
          <span className="material-picker__count" role="status">
            已选 {selection.size} 个材料
          </span>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onConfirm(new Set(selection))}>
            确认选择
          </Button>
        </>
      }
    >
      <div className="material-picker">
        <Field label="搜索文件" hint="按文件名、文件 ID 或来源任务 ID 搜索。">
          <Input
            ref={searchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        {available.length === 0 ? (
          <EmptyState
            title="暂无可选文件"
            description="可以取消选择，上传本地材料后开始任务。"
          />
        ) : matches.length === 0 ? (
          <EmptyState
            title="没有匹配文件"
            description="换个关键词或清空搜索后重试。"
          />
        ) : (
          <ul className="material-picker__list" aria-label="可选文件">
            {matches.map((file) => (
              <li className="material-picker__item" key={file.id}>
                <label className="material-picker__option">
                  <input
                    type="checkbox"
                    checked={selection.has(file.id)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelection((current) => {
                        const next = new Set(current);
                        if (checked) next.add(file.id);
                        else next.delete(file.id);
                        return next;
                      });
                    }}
                  />
                  <FileText size={16} aria-hidden="true" />
                  <span className="material-picker__file">
                    <span className="material-picker__name">{file.name}</span>
                    <span className="material-picker__id">{file.id}</span>
                    {file.sessionId ? (
                      <span className="material-picker__source">
                        来源任务：{file.sessionId}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
